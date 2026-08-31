/**
 * The moderation queue, read side.
 *
 * `moderation_queue` has had two producers since the listings and messaging
 * modules shipped — a listing on submit, a message on flag or block — and no
 * reader at all. This is the reader.
 *
 * That absence was not cosmetic. `pending_review → live` is staff-only by
 * design, so with no way to see what is waiting, the only route to publishing
 * a listing was to already know its id. Nothing reached the public.
 *
 * SIZED FOR TWO TO FIVE DECISIONS A DAY (see analysis/10):
 *
 *  - No bulk actions. At this volume every item is opened and read, and a
 *    select-all is a feature for a queue nobody reads carefully.
 *  - No assignment or routing. There is one moderator.
 *  - Rows carry the SIGNAL NAMES behind the score, not just the number. A
 *    number says how worried to be; the names say what to look at, and a rule
 *    that fires wrongly is only findable if it is on the screen.
 */
import { notFound } from '../../lib/errors.js';
import type { Sql } from '../../db/pool.js';

export type QueueSubject = 'listing' | 'user' | 'message';
export type QueueState = 'open' | 'approved' | 'rejected' | 'changes_requested';

export interface QueueSignal {
  signal: string;
  weight: number;
  detail: Record<string, unknown>;
  at: Date;
}

export interface QueueItem {
  id: string;
  subjectType: QueueSubject;
  subjectId: string;
  reason: string;
  riskScore: number;
  state: QueueState;
  createdAt: Date;
  /** Seconds the item has been waiting. The number that actually matters. */
  waitingSec: number;
  /** A one-line description of the thing, so the list is readable. */
  title: string;
  subtitle: string;
  signals: QueueSignal[];
}

export interface QueueStats {
  open: number;
  openListings: number;
  openMessages: number;
  /** Age of the longest-waiting open item, in seconds. Null when empty. */
  oldestWaitingSec: number | null;
  blockedLast7d: number;
  releasedLast7d: number;
}

export class ModerationService {
  readonly #db: Sql;
  readonly #now: () => Date;

  constructor(db: Sql, opts: { now?: () => Date } = {}) {
    this.#db = db;
    this.#now = opts.now ?? (() => new Date());
  }

  /**
   * The queue.
   *
   * Ordered by `risk_score DESC, created_at` — exactly what
   * `moderation_queue_open_idx` is built for, so this stays an index scan as
   * the table grows.
   *
   * Titles are resolved in one pass with two LEFT JOINs rather than a query
   * per row: a list that fetches each subject separately is the N+1 that turns
   * a fast page slow at fifty items.
   */
  async list(opts: {
    state?: QueueState;
    subjectType?: QueueSubject;
    limit?: number;
    offset?: number;
  } = {}): Promise<QueueItem[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const state = opts.state ?? 'open';

    const res = await this.#db.query<QueueRow>(
      `SELECT q.id, q.subject_type, q.subject_id, q.reason,
              q.risk_score::float8 AS risk_score, q.state, q.created_at,
              l.title AS listing_title, l.price_cents::text AS price_cents,
              l.mode AS listing_mode, l.beds AS listing_beds,
              p.address_line, p.city,
              m.body AS message_body, m.moderation_verdict,
              mu.email AS sender_email,
              ml.title AS message_listing_title
         FROM moderation_queue q
         LEFT JOIN listings l  ON q.subject_type = 'listing' AND l.id = q.subject_id
         LEFT JOIN properties p ON p.id = l.property_id
         LEFT JOIN messages m  ON q.subject_type = 'message' AND m.id = q.subject_id
         LEFT JOIN users mu    ON mu.id = m.sender_id
         LEFT JOIN threads mt  ON mt.id = m.thread_id
         LEFT JOIN listings ml ON ml.id = mt.listing_id
        WHERE q.state = $3
          AND ($4::text IS NULL OR q.subject_type = $4)
        ORDER BY q.risk_score DESC, q.created_at
        LIMIT $1 OFFSET $2`,
      [limit, offset, state, opts.subjectType ?? null],
    );
    if (res.rows.length === 0) return [];

    const signals = await this.#signalsFor(res.rows.map((r) => r.subject_id));
    const now = this.#now().getTime();

    return res.rows.map((r) => ({
      id: r.id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      reason: r.reason,
      riskScore: Number(r.risk_score),
      state: r.state,
      createdAt: r.created_at,
      waitingSec: Math.max(0, Math.round((now - r.created_at.getTime()) / 1000)),
      ...describe(r),
      signals: signals.get(r.subject_id) ?? [],
    }));
  }

  /** One item, with everything a two-minute decision needs. */
  async get(itemId: string): Promise<QueueItem> {
    const res = await this.#db.query<QueueRow>(
      `SELECT q.id, q.subject_type, q.subject_id, q.reason,
              q.risk_score::float8 AS risk_score, q.state, q.created_at,
              l.title AS listing_title, l.price_cents::text AS price_cents,
              l.mode AS listing_mode, l.beds AS listing_beds,
              p.address_line, p.city,
              m.body AS message_body, m.moderation_verdict,
              mu.email AS sender_email,
              ml.title AS message_listing_title
         FROM moderation_queue q
         LEFT JOIN listings l  ON q.subject_type = 'listing' AND l.id = q.subject_id
         LEFT JOIN properties p ON p.id = l.property_id
         LEFT JOIN messages m  ON q.subject_type = 'message' AND m.id = q.subject_id
         LEFT JOIN users mu    ON mu.id = m.sender_id
         LEFT JOIN threads mt  ON mt.id = m.thread_id
         LEFT JOIN listings ml ON ml.id = mt.listing_id
        WHERE q.id = $1`,
      [itemId],
    );
    const row = res.rows[0];
    if (!row) throw notFound('Queue item not found.');

    const signals = await this.#signalsFor([row.subject_id]);
    return {
      id: row.id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      reason: row.reason,
      riskScore: Number(row.risk_score),
      state: row.state,
      createdAt: row.created_at,
      waitingSec: Math.max(0, Math.round((this.#now().getTime() - row.created_at.getTime()) / 1000)),
      ...describe(row),
      signals: signals.get(row.subject_id) ?? [],
    };
  }

  /**
   * Queue health.
   *
   * `oldestWaitingSec` is the headline rather than depth: at two to five
   * items a day the failure mode is not a queue that is too deep, it is a
   * queue nobody opened for a week.
   *
   * Blocked and released counts sit together on purpose. A rising block rate
   * with rising releases means the heuristic is over-firing; with releases
   * near zero it means the site is under attack. The responses are opposite,
   * and neither number alone distinguishes them.
   */
  async stats(): Promise<QueueStats> {
    const res = await this.#db.query<{
      open: string; open_listings: string; open_messages: string;
      oldest: Date | null; blocked: string; released: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM moderation_queue WHERE state = 'open') AS open,
         (SELECT count(*)::text FROM moderation_queue
           WHERE state = 'open' AND subject_type = 'listing') AS open_listings,
         (SELECT count(*)::text FROM moderation_queue
           WHERE state = 'open' AND subject_type = 'message') AS open_messages,
         (SELECT min(created_at) FROM moderation_queue WHERE state = 'open') AS oldest,
         (SELECT count(*)::text FROM messages
           WHERE moderation_verdict = 'block' AND created_at > now() - interval '7 days') AS blocked,
         (SELECT count(*)::text FROM audit_log
           WHERE action = 'message.release' AND at > now() - interval '7 days') AS released`,
    );
    const r = res.rows[0];
    const oldest = r?.oldest ?? null;
    return {
      open: Number(r?.open ?? 0),
      openListings: Number(r?.open_listings ?? 0),
      openMessages: Number(r?.open_messages ?? 0),
      oldestWaitingSec: oldest
        ? Math.max(0, Math.round((this.#now().getTime() - oldest.getTime()) / 1000))
        : null,
      blockedLast7d: Number(r?.blocked ?? 0),
      releasedLast7d: Number(r?.released ?? 0),
    };
  }

  /**
   * Closes an item without acting on its subject.
   *
   * For the case where a moderator looks and decides nothing needs doing —
   * common for a listing that queued on a weak signal. The listing and
   * message decision paths close their own entries inside the transaction
   * that makes the decision; this is only for "looked, fine".
   */
  async dismiss(itemId: string, staffId: string): Promise<void> {
    const res = await this.#db.query(
      `UPDATE moderation_queue
          SET state = 'approved', decided_by = $2, decided_at = now()
        WHERE id = $1 AND state = 'open'`,
      [itemId, staffId],
    );
    if (res.rowCount === 0) throw notFound('Queue item not found, or already decided.');
  }

  /** Signals for a page of subjects, in one query. */
  async #signalsFor(subjectIds: readonly string[]): Promise<Map<string, QueueSignal[]>> {
    const out = new Map<string, QueueSignal[]>();
    if (subjectIds.length === 0) return out;

    const res = await this.#db.query<{
      subject_id: string; signal: string; weight: string;
      detail: Record<string, unknown>; at: Date;
    }>(
      `SELECT subject_id, signal, weight::text, detail, at
         FROM risk_signals
        WHERE subject_id = ANY($1::uuid[])
          AND at > now() - interval '30 days'
        ORDER BY weight DESC, at DESC`,
      [subjectIds as string[]],
    );
    for (const r of res.rows) {
      const list = out.get(r.subject_id) ?? [];
      list.push({ signal: r.signal, weight: Number(r.weight), detail: r.detail, at: r.at });
      out.set(r.subject_id, list);
    }
    return out;
  }
}

interface QueueRow {
  id: string;
  subject_type: QueueSubject;
  subject_id: string;
  reason: string;
  risk_score: number;
  state: QueueState;
  created_at: Date;
  listing_title: string | null;
  price_cents: string | null;
  listing_mode: string | null;
  listing_beds: number | null;
  address_line: string | null;
  city: string | null;
  message_body: string | null;
  moderation_verdict: string | null;
  sender_email: string | null;
  message_listing_title: string | null;
}

/**
 * One readable line per row.
 *
 * A message subtitle deliberately does NOT quote the body: the queue list is
 * scanned in public, on a laptop, and the body of a flagged message is exactly
 * the text that should not be readable over someone's shoulder. It is on the
 * review screen, which is a deliberate click.
 */
function describe(r: QueueRow): { title: string; subtitle: string } {
  if (r.subject_type === 'listing') {
    const price = r.price_cents ? `$${(Number(r.price_cents) / 100).toLocaleString('en-CA')}` : '';
    const per = r.listing_mode === 'rent' ? '/mo' : '';
    const beds = r.listing_beds === null ? '' : ` · ${r.listing_beds} bed`;
    return {
      title: r.address_line ? `${r.address_line} · ${r.city ?? ''}`.trim() : (r.listing_title ?? 'Listing'),
      subtitle: `listing · ${price}${per}${beds}`.trim(),
    };
  }
  if (r.subject_type === 'message') {
    return {
      title: r.sender_email ? `Message from ${r.sender_email}` : 'Message',
      subtitle: `${r.moderation_verdict ?? 'flagged'} · ${r.message_listing_title ?? 'a listing'}`,
    };
  }
  return { title: 'Account', subtitle: r.reason };
}
