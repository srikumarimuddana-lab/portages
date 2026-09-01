/**
 * The audit trail.
 *
 * `audit_log` has carried a `forbid_mutation()` trigger on UPDATE and DELETE
 * since migration 006 — a compromised application role can add to it and
 * cannot rewrite it — and until now nothing wrote to it at all.
 *
 * It ships BEFORE the first admin action, not after, and that ordering is the
 * point. A trail added later has no rows for the period before it, which is
 * exactly the period in which a young platform's judgement calls get
 * questioned: the first rejection, the first suspension, the first released
 * message. Those are the entries worth having.
 *
 * TWO RULES that make it hard to end up with a decision nobody recorded:
 *
 *  1. `record()` takes an Sql, so it is called with the SAME transaction as
 *     the change it describes. The decision and its record commit together or
 *     roll back together — there is no window in which one exists without the
 *     other.
 *
 *  2. Actions are a closed union, not free text. A typo'd action string is a
 *     row nobody will ever find when they search for it.
 */
import { pseudonymize } from '../../lib/crypto.js';
import type { Sql } from '../../db/pool.js';
import type { UserRole } from '../auth/service.js';

/**
 * Every auditable action.
 *
 * Named `subject.verb` so the log sorts and filters usefully, and so a new
 * one is obviously a new one rather than a variant spelling of an old one.
 */
export const AUDIT_ACTIONS = [
  'listing.approve',
  'listing.reject',
  'listing.request_changes',
  'message.release',
  'message.uphold',
  'user.suspend',
  'user.reinstate',
  'user.role_change',
  'report.resolve',
  'report.dismiss',
  'flag.set',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  actorId: string;
  actorRole: UserRole;
  action: AuditAction;
  /** The kind of thing acted on: 'listing', 'message', 'user', 'report'. */
  subject: string;
  subjectId: string;
  /** State before and after, for anything that changed a value. */
  before?: Record<string, unknown> | undefined;
  after?: Record<string, unknown> | undefined;
  /** Raw IP. Hashed here; never stored in the clear. */
  ip?: string | undefined;
}

export interface AuditRow {
  id: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  subject: string;
  subjectId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: Date;
}

export class AuditService {
  readonly #pepper: string;

  constructor(pepper: string) {
    this.#pepper = pepper;
  }

  /**
   * Writes one entry.
   *
   * Takes the Sql to run on rather than holding its own, so the caller passes
   * the transaction that is making the change. That is what keeps a decision
   * and its record atomic.
   */
  async record(db: Sql, entry: AuditEntry): Promise<void> {
    await db.query(
      `INSERT INTO audit_log
         (actor_id, actor_role, action, subject, subject_id, before, after, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        entry.actorId,
        entry.actorRole,
        entry.action,
        entry.subject,
        entry.subjectId,
        entry.before ? JSON.stringify(entry.before) : null,
        entry.after ? JSON.stringify(entry.after) : null,
        // Pseudonymized like every other IP in this codebase. An audit trail
        // that retains raw addresses is itself a privacy liability.
        entry.ip ? pseudonymize(entry.ip, this.#pepper) : null,
      ],
    );
  }

  /**
   * Reads the trail. Admin-only at the route layer.
   *
   * Keyset paginated on the bigserial id, which is monotonic here because the
   * table only ever receives inserts.
   */
  async list(
    db: Sql,
    opts: { limit?: number; beforeId?: string; action?: AuditAction; subjectId?: string } = {},
  ): Promise<AuditRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const res = await db.query<{
      id: string; actor_id: string | null; actor_role: string | null;
      action: string; subject: string; subject_id: string | null;
      before: Record<string, unknown> | null; after: Record<string, unknown> | null;
      at: Date;
    }>(
      `SELECT id::text, actor_id, actor_role, action, subject, subject_id,
              before, after, at
         FROM audit_log
        WHERE ($2::bigint IS NULL OR id < $2::bigint)
          AND ($3::text IS NULL OR action = $3)
          AND ($4::text IS NULL OR subject_id = $4)
        ORDER BY id DESC
        LIMIT $1`,
      [limit, opts.beforeId ?? null, opts.action ?? null, opts.subjectId ?? null],
    );
    return res.rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      actorRole: r.actor_role,
      action: r.action,
      subject: r.subject,
      subjectId: r.subject_id,
      before: r.before,
      after: r.after,
      at: r.at,
    }));
  }
}

/** What the admin services need, narrowed so they cannot read the trail. */
export interface AuditRecorder {
  record(db: Sql, entry: AuditEntry): Promise<void>;
}
