/**
 * User reports.
 *
 * The human half of moderation. `moderation_queue` has had two producers
 * since Sprints 4 and 6 — a listing on submit, a message on flag — and both
 * are heuristics. A regex does not know that the photos are of the reporter's
 * own living room, that the "owner" was struck off, or that the flat was let
 * three weeks ago. A person does, and until now there was no way for them to
 * say so.
 *
 * THE DESIGN PROBLEM IS CORROBORATION, not collection. Writing a row is easy.
 * The question is what ten reports mean:
 *
 *   ten people reporting one listing   corroboration. Weight it up, fast.
 *   one person reporting it ten times  one opinion, or a grudge. Weight once.
 *
 * A count(*) cannot tell those apart, so the database refuses the second
 * (migration 017's partial unique index) and the risk score is computed from
 * distinct reporters. Everything else here follows from that.
 *
 * REPORTS DO NOT ACT ON THEIR OWN. No number of them takes a listing down.
 * That is deliberate and it is the difference between a report button and a
 * brigading tool: on a site with a few thousand listings, forty accounts is
 * an afternoon's work for someone motivated, and an auto-takedown at five
 * reports would make Portage trivially weaponisable against a competitor.
 * Reports raise the queue position. A human still decides.
 */
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import type { AuditRecorder } from '../audit/service.js';
import type { Sql } from '../../db/pool.js';
import type { UserRole } from '../auth/service.js';

export const REPORT_KINDS = [
  'scam', 'misleading', 'already_rented', 'offensive', 'duplicate', 'other',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_SUBJECTS = ['listing', 'user', 'message', 'pro'] as const;
export type ReportSubject = (typeof REPORT_SUBJECTS)[number];

export type Severity = 'low' | 'normal' | 'high' | 'critical';

/**
 * What each kind is worth on its own.
 *
 * `already_rented` is the most common report on any classifieds site and the
 * least alarming — it means the listing is stale, not that anyone is lying.
 * Treating it as equal to `scam` would bury real fraud under housekeeping,
 * which is exactly how a moderation queue stops being read.
 */
const BASE_SEVERITY: Record<ReportKind, Severity> = {
  scam: 'high',
  offensive: 'high',
  misleading: 'normal',
  duplicate: 'low',
  already_rented: 'low',
  other: 'normal',
};

/** What one report of each kind adds to the queue's risk score. */
const KIND_WEIGHT: Record<ReportKind, number> = {
  scam: 45,
  offensive: 35,
  misleading: 20,
  duplicate: 8,
  already_rented: 6,
  other: 12,
};

/**
 * Corroboration multiplier by distinct reporter count.
 *
 * Deliberately sub-linear. The second person to report something roughly
 * doubles the evidence; the tenth adds very little that the first three did
 * not, and letting it scale linearly is what turns a report button into a
 * brigading tool. Caps out, so no amount of coordinated reporting can push a
 * listing past the point a human decides.
 */
export function corroborationFactor(distinctReporters: number): number {
  if (distinctReporters <= 1) return 1;
  return Math.min(1 + Math.log2(distinctReporters), 3);
}

export interface CreateReport {
  reporterId: string;
  subjectType: ReportSubject;
  subjectId: string;
  kind: ReportKind;
  detail?: string | null;
}

export interface ReportView {
  id: string;
  subjectType: ReportSubject;
  subjectId: string;
  kind: ReportKind;
  detail: string | null;
  severity: Severity;
  status: 'open' | 'resolved' | 'dismissed';
  createdAt: Date;
  /** How many DISTINCT people have an open report against this subject. */
  reporterCount: number;
}

export interface ReportServiceDeps {
  db: Sql;
  audit?: AuditRecorder | null;
}

export class ReportService {
  readonly #db: Sql;
  readonly #audit: AuditRecorder | null;

  constructor(deps: ReportServiceDeps) {
    this.#db = deps.db;
    this.#audit = deps.audit ?? null;
  }

  /**
   * Files a report and updates the subject's place in the queue.
   *
   * ANONYMOUS REPORTING IS NOT SUPPORTED, and the column being nullable is
   * about accounts being deleted later, not about accepting anonymous
   * submissions now. Three reasons, in order of weight:
   *
   *   1. A moderator's most useful next step is usually "what happened?" —
   *      a report nobody can reply to is much weaker evidence.
   *   2. An anonymous endpoint rate-limited by IP is trivially defeated, and
   *      it is the shape of tool used to bury a competitor.
   *   3. Encountering a scam on Portage almost always means messaging
   *      someone, which already needs an account.
   *
   * The cost is real — someone who spots a bad listing while browsing has to
   * sign up to say so — and if that turns out to matter, the schema already
   * allows it and this is the one method that would change.
   */
  async create(input: CreateReport): Promise<ReportView> {
    const detail = input.detail?.trim() || null;
    if (detail && detail.length > 4000) {
      throw badRequest('Keep the description under 4000 characters.');
    }
    if (input.kind === 'other' && !detail) {
      // "Other" with no explanation is an item a moderator opens, learns
      // nothing from, and closes. Asking for one sentence is cheaper than
      // that, for everyone.
      throw badRequest('Tell us what is wrong, in a sentence or two.');
    }

    await this.#assertSubjectExists(input.subjectType, input.subjectId);

    return this.#db.transaction(async (tx) => {
      let row;
      try {
        const res = await tx.query<ReportRow>(
          `INSERT INTO reports (reporter_id, subject_type, subject_id, kind, detail, severity)
                VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, subject_type, subject_id, kind, detail, severity, status, created_at`,
          [
            input.reporterId, input.subjectType, input.subjectId,
            input.kind, detail, BASE_SEVERITY[input.kind],
          ],
        );
        row = res.rows[0]!;
      } catch (err) {
        // The partial unique index from migration 017. Reported as a conflict
        // rather than silently succeeding, because "thanks, we got it" for a
        // report that changed nothing teaches people the button does not work.
        if (isUniqueViolation(err, 'reports_one_open_per_reporter_idx')) {
          throw conflict('You have already reported this. We are looking at it.');
        }
        throw err;
      }

      // Distinct reporters, not report count — see the file header. The two
      // are the same number until somebody games it, which is when the
      // difference matters.
      const counted = await tx.query<{ n: string; worst: string }>(
        `SELECT count(DISTINCT reporter_id)::text AS n,
                max(CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3
                                  WHEN 'normal' THEN 2 ELSE 1 END)::text AS worst
           FROM reports
          WHERE subject_type = $1 AND subject_id = $2 AND status = 'open'`,
        [input.subjectType, input.subjectId],
      );
      const reporterCount = Number(counted.rows[0]?.n ?? 1);
      const score = Math.round(
        KIND_WEIGHT[input.kind] * corroborationFactor(reporterCount),
      );

      // GREATEST, so a stream of low-severity `already_rented` reports can
      // never drag a subject DOWN the queue below where a single `scam`
      // report already put it.
      await tx.query(
        `INSERT INTO moderation_queue (subject_type, subject_id, reason, risk_score)
              VALUES ($1, $2, $3, $4)
         ON CONFLICT (subject_type, subject_id) WHERE state = 'open'
         DO UPDATE SET risk_score = GREATEST(moderation_queue.risk_score, EXCLUDED.risk_score),
                       reason = EXCLUDED.reason`,
        [
          input.subjectType, input.subjectId,
          `user_report_${input.kind}${reporterCount > 1 ? `_x${reporterCount}` : ''}`,
          score,
        ],
      );

      await tx.query(
        `INSERT INTO risk_signals (subject_type, subject_id, signal, weight, detail)
              VALUES ($1, $2, $3, $4, $5)`,
        [
          input.subjectType, input.subjectId, `report_${input.kind}`,
          Math.min(KIND_WEIGHT[input.kind], 100),
          JSON.stringify({ reporterCount }),
        ],
      );

      return { ...toView(row), reporterCount };
    });
  }

  /** The open reports against one subject, for the review screen. */
  async forSubject(subjectType: ReportSubject, subjectId: string): Promise<ReportView[]> {
    const res = await this.#db.query<ReportRow & { n: string }>(
      `SELECT r.id, r.subject_type, r.subject_id, r.kind, r.detail, r.severity,
              r.status, r.created_at,
              (SELECT count(DISTINCT reporter_id)::text FROM reports
                WHERE subject_type = r.subject_type AND subject_id = r.subject_id
                  AND status = 'open') AS n
         FROM reports r
        WHERE r.subject_type = $1 AND r.subject_id = $2
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [subjectType, subjectId],
    );
    return res.rows.map((r) => ({ ...toView(r), reporterCount: Number(r.n) }));
  }

  /**
   * Closes every open report against a subject, in one decision.
   *
   * Per subject rather than per report on purpose: a moderator looks at the
   * listing once and reaches one conclusion. Making them close eight reports
   * individually is how the eighth gets left open, and an open report is what
   * keeps a subject in the queue.
   */
  async decide(
    subjectType: ReportSubject,
    subjectId: string,
    outcome: 'resolved' | 'dismissed',
    staff: { userId: string; role: UserRole; ip?: string | undefined },
  ): Promise<{ closed: number }> {
    return this.#db.transaction(async (tx) => {
      const res = await tx.query(
        `UPDATE reports SET status = $3, resolved_at = now()
          WHERE subject_type = $1 AND subject_id = $2 AND status = 'open'`,
        [subjectType, subjectId, outcome],
      );
      if (res.rowCount === 0) throw notFound('No open reports for that subject.');

      await tx.query(
        `UPDATE moderation_queue
            SET state = $3, decided_by = $4, decided_at = now()
          WHERE subject_type = $1 AND subject_id = $2 AND state = 'open'`,
        [subjectType, subjectId, outcome === 'resolved' ? 'approved' : 'rejected', staff.userId],
      );

      await this.#audit?.record(tx, {
        actorId: staff.userId,
        actorRole: staff.role,
        action: outcome === 'resolved' ? 'report.resolve' : 'report.dismiss',
        subject: subjectType,
        subjectId,
        after: { closed: res.rowCount },
        ip: staff.ip,
      });

      return { closed: res.rowCount };
    });
  }

  /**
   * Whether a subject exists at all.
   *
   * Checked before the insert so a stranger cannot use the report endpoint to
   * probe which listing ids are real — the 404 for "no such listing" and for
   * "listing you cannot see" are the same 404 everywhere else in this
   * codebase, and this must not be the exception that leaks.
   */
  async #assertSubjectExists(subjectType: ReportSubject, subjectId: string): Promise<void> {
    const table = { listing: 'listings', user: 'users', message: 'messages', pro: 'pros' }[subjectType];
    // `table` comes from a closed union, never from a request — the only
    // reason an identifier is interpolated anywhere in this codebase.
    const res = await this.#db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [subjectId]);
    if (res.rowCount === 0) throw notFound('That is no longer here.');
  }
}

interface ReportRow {
  id: string;
  subject_type: ReportSubject;
  subject_id: string;
  kind: ReportKind;
  detail: string | null;
  severity: Severity;
  status: 'open' | 'resolved' | 'dismissed';
  created_at: Date;
}

function toView(r: ReportRow): Omit<ReportView, 'reporterCount'> {
  return {
    id: r.id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    kind: r.kind,
    detail: r.detail,
    severity: r.severity,
    status: r.status,
    createdAt: r.created_at,
  };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && (e.constraint === constraint || e.constraint === undefined);
}
