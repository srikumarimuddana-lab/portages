/**
 * Threads and messages — the owner's enquiry inbox.
 *
 * Rules that hold throughout, each of them a thing a marketplace gets wrong
 * exactly once:
 *
 *  1. A thread the caller is not party to does not exist. Not 403 — a 403
 *     confirms the id is real and tells a stranger there is a conversation
 *     between two named people about a property.
 *
 *  2. Enquiries start on LIVE listings only. A draft is private; a paused or
 *     closed listing is not taking enquiries and saying so is kinder than a
 *     message nobody answers.
 *
 *  3. Every message passes moderation BEFORE delivery, and a blocked message
 *     is never written to the recipient's view. The sender is told it did not
 *     send; the recipient never knows it existed.
 *
 *  4. Blocking is one-sided and asymmetric: the person who blocked can undo
 *     it, the person who was blocked cannot, and cannot tell the difference
 *     between being blocked and being ignored.
 */
import {
  BLOCKED_NOTICE, ESTABLISHED_AFTER, previewFor, riskScoreOf, scanMessage,
  type Verdict,
} from './policy.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { idempotencyKeyFor } from '../notify/service.js';
import type { NotifyService } from '../notify/service.js';
import type { AuditRecorder } from '../audit/service.js';
import type { AiModerationService } from '../ai/moderation.js';
import type { Sql } from '../../db/pool.js';

/**
 * How long the send path will wait for an AI second opinion.
 *
 * Two seconds, not the adapter's twenty. This sits between a person pressing
 * send and their message existing; a slow model must cost the opinion, never
 * the message.
 */
const AI_TRIAGE_DEADLINE_MS = 2_000;

export type ThreadStatus = 'open' | 'archived' | 'blocked';
export type Party = 'owner' | 'inquirer';

export interface ThreadSummary {
  id: string;
  listingId: string;
  listingTitle: string;
  listingStatus: string;
  /** The other person, from the caller's point of view. */
  counterpartyId: string;
  status: ThreadStatus;
  /** Which side the caller is on. Drives what they are allowed to do. */
  role: Party;
  messageCount: number;
  unreadCount: number;
  lastAt: Date;
  lastPreview: string | null;
  blockedByMe: boolean;
}

export interface MessageView {
  id: string;
  senderId: string;
  body: string;
  kind: string;
  createdAt: Date;
  /** True when the message was delivered but carries a warning. */
  flagged: boolean;
  mine: boolean;
}

export interface ThreadDetail extends ThreadSummary {
  messages: MessageView[];
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  verdict: Verdict;
  /** Present when the message was withheld. */
  notice?: string;
  /** True when the owner appears to have said the listing is gone. */
  suggestsClosed?: boolean;
}

export interface MessagingDeps {
  db: Sql;
  notify: NotifyService;
  /** Public origin, for links in notification emails. */
  appOrigin: string;
  /** Records staff releases in the same transaction that makes them. */
  audit?: AuditRecorder | null;
  /**
   * Optional second opinion on ambiguous messages. Absent means rules only,
   * which is exactly how this worked before AI existed and remains the
   * behaviour whenever the model is off, slow, or wrong.
   */
  aiModeration?: AiModerationService | null;
  now?: () => Date;
}

/** Who is acting, when a staff member reviews a withheld message. */
export interface StaffViewer {
  userId: string;
  role: 'staff' | 'admin';
  ip?: string | undefined;
}

interface ThreadRow {
  id: string;
  listing_id: string;
  owner_id: string;
  inquirer_id: string;
  status: ThreadStatus;
  message_count: number;
  last_at: Date;
  owner_read_at: Date | null;
  inquirer_read_at: Date | null;
  blocked_by: string | null;
}

export class MessagingService {
  readonly #db: Sql;
  readonly #notify: NotifyService;
  readonly #origin: string;
  readonly #now: () => Date;
  readonly #audit: AuditRecorder | null;
  readonly #aiModeration: AiModerationService | null;

  constructor(deps: MessagingDeps) {
    this.#db = deps.db;
    this.#notify = deps.notify;
    this.#origin = deps.appOrigin;
    this.#audit = deps.audit ?? null;
    this.#aiModeration = deps.aiModeration ?? null;
    this.#now = deps.now ?? (() => new Date());
  }

  // ── starting a conversation ───────────────────────────────────────────────

  /**
   * Opens a thread on a live listing, or reuses the existing one.
   *
   * `threads_unique_idx` allows one thread per (listing, inquirer), so a
   * second enquiry on the same listing continues the first conversation
   * rather than starting a parallel one the owner has to reconcile.
   */
  async startThread(input: {
    listingId: string;
    inquirerId: string;
    body: string;
  }): Promise<SendResult & { threadId: string }> {
    const body = input.body.trim();
    if (body.length === 0) throw badRequest('Write a message before sending.');

    const listing = await this.#db.query<{ id: string; owner_id: string; status: string; title: string }>(
      'SELECT id, owner_id, status, title FROM listings WHERE id = $1',
      [input.listingId],
    );
    const row = listing.rows[0];
    // A listing that is not live is not visible to a stranger, so its absence
    // and its unavailability are reported the same way.
    if (!row || row.status !== 'live') throw notFound('Listing not found.');
    if (row.owner_id === input.inquirerId) {
      throw badRequest('You cannot send an enquiry about your own listing.');
    }

    const threadId = await this.#db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string; status: ThreadStatus; blocked_by: string | null }>(
        'SELECT id, status, blocked_by FROM threads WHERE listing_id = $1 AND inquirer_id = $2',
        [input.listingId, input.inquirerId],
      );
      const found = existing.rows[0];
      if (found) {
        // A blocked thread is reported as an ordinary send failure rather than
        // "you are blocked" — see #assertCanPost.
        if (found.status === 'blocked') throw sendUnavailable();
        return found.id;
      }

      const created = await tx.query<{ id: string }>(
        `INSERT INTO threads (listing_id, owner_id, inquirer_id)
         VALUES ($1,$2,$3)
         RETURNING id`,
        [input.listingId, row.owner_id, input.inquirerId],
      );
      return created.rows[0]!.id;
    });

    const sent = await this.#post({
      threadId,
      senderId: input.inquirerId,
      recipientId: row.owner_id,
      body,
      listingTitle: row.title,
      senderIsOwner: false,
    });
    return { ...sent, threadId };
  }

  /** Adds a message to an existing thread. */
  async reply(input: { threadId: string; senderId: string; body: string }): Promise<SendResult> {
    const body = input.body.trim();
    if (body.length === 0) throw badRequest('Write a message before sending.');

    const thread = await this.#loadThread(input.threadId, input.senderId);
    this.#assertCanPost(thread, input.senderId);

    const isOwner = thread.owner_id === input.senderId;
    const listing = await this.#db.query<{ title: string }>(
      'SELECT title FROM listings WHERE id = $1',
      [thread.listing_id],
    );

    return this.#post({
      threadId: thread.id,
      senderId: input.senderId,
      recipientId: isOwner ? thread.inquirer_id : thread.owner_id,
      body,
      listingTitle: listing.rows[0]?.title ?? 'your listing',
      senderIsOwner: isOwner,
      threadMessageCount: thread.message_count,
    });
  }

  /**
   * The one path a message takes. Moderate, then write, then notify.
   *
   * A blocked message is recorded — a moderator needs to see what was
   * attempted, and a pattern of blocked messages is itself the signal — but
   * `delivered_at` stays null, and every read path filters on it.
   */
  async #post(input: {
    threadId: string;
    senderId: string;
    recipientId: string;
    body: string;
    listingTitle: string;
    senderIsOwner: boolean;
    threadMessageCount?: number;
  }): Promise<SendResult> {
    const count = input.threadMessageCount ?? 0;
    const scan = scanMessage({
      body: input.body,
      threadMessageCount: count,
      senderIsOwner: input.senderIsOwner,
    });

    // AI triage, when it is wired and the rules were unsure. It can raise the
    // verdict and never lower it — see modules/ai/moderation.ts for why that
    // asymmetry is the entire safety argument.
    //
    // A DEADLINE, not just the adapter's own timeout: this sits between a
    // person pressing send and their message existing, and twenty seconds of
    // "sending..." is worse than a message the rules judged alone. Two
    // seconds is enough for the small classification call this makes, and
    // triage() treats a miss as "no opinion" rather than an error.
    let verdict = scan.verdict;
    let signals = scan.signals;
    if (this.#aiModeration) {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), AI_TRIAGE_DEADLINE_MS);
      try {
        const triage = await this.#aiModeration.triage(
          {
            body: input.body,
            scan,
            threadMessageCount: count,
            senderIsOwner: input.senderIsOwner,
          },
          { signal: deadline.signal },
        );
        verdict = triage.verdict;
        if (triage.added.length > 0) signals = [...signals, ...triage.added];
      } finally {
        clearTimeout(timer);
      }
    }

    const delivered = verdict !== 'block';
    const now = this.#now();

    const messageId = await this.#db.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO messages
           (thread_id, sender_id, body, moderation_verdict, moderation_at,
            flagged_reasons, delivered_at, is_first_contact)
         VALUES ($1,$2,$3,$4,now(),$5,$6,$7)
         RETURNING id`,
        [
          input.threadId, input.senderId, input.body, verdict,
          signals.map((s) => s.reason),
          delivered ? now : null,
          count === 0,
        ],
      );

      if (delivered) {
        // last_at and message_count move only for delivered messages, so a
        // blocked message cannot bump a thread to the top of someone's inbox.
        await tx.query(
          `UPDATE threads
              SET last_at = $2, message_count = message_count + 1
            WHERE id = $1`,
          [input.threadId, now],
        );
      }

      if (verdict !== 'allow') {
        for (const s of signals) {
          await tx.query(
            `INSERT INTO risk_signals (subject_type, subject_id, signal, weight, detail)
             VALUES ('message', $1, $2, $3, $4)`,
            [inserted.rows[0]!.id, s.reason, Math.min(s.weight, 100), JSON.stringify({
              threadId: input.threadId, absolute: s.absolute,
            })],
          );
        }
        await tx.query(
          `INSERT INTO moderation_queue (subject_type, subject_id, reason, risk_score)
           VALUES ('message', $1, $2, $3)
           ON CONFLICT (subject_type, subject_id) WHERE state = 'open'
           DO UPDATE SET risk_score = EXCLUDED.risk_score`,
          [inserted.rows[0]!.id, `message_${verdict}`, riskScoreOf(signals)],
        );
      }

      return inserted.rows[0]!.id;
    });

    if (!delivered) {
      return { ok: false, verdict, notice: BLOCKED_NOTICE };
    }

    await this.#notifyRecipient({
      recipientId: input.recipientId,
      threadId: input.threadId,
      listingTitle: input.listingTitle,
      body: input.body,
      // The merged verdict, not the rules' one. previewFor omits the body of
      // a flagged message, so an AI escalation from allow to flag must reach
      // here — otherwise a message we just judged risky arrives in full in
      // the recipient's email, which is the one place the warning is not.
      verdict,
      messageId,
    });

    return {
      ok: true,
      messageId,
      verdict,
      // suggestsClosed comes from the rules and is about the owner saying the
      // unit is gone. AI has no opinion on it and does not get one.
      ...(scan.suggestsClosed ? { suggestsClosed: true } : {}),
    };
  }

  /**
   * Tells the other party there is a message waiting.
   *
   * Transactional: someone enquiring about your listing is not marketing, and
   * an owner who does not hear about enquiries has no reason to use the site.
   * Suppressions still apply — the notify layer enforces that a hard-bounced
   * address is never written to again, whatever the category.
   *
   * The preview is omitted for a flagged message. Otherwise a message we
   * judged risky enough to warn about in-app would arrive in full in the
   * recipient's email, which is the one place the warning is not.
   */
  async #notifyRecipient(input: {
    recipientId: string;
    threadId: string;
    listingTitle: string;
    body: string;
    verdict: Verdict;
    messageId: string;
  }): Promise<void> {
    const user = await this.#db.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1 AND status = 'active'`,
      [input.recipientId],
    );
    const email = user.rows[0]?.email;
    if (!email) return;

    try {
      await this.#notify.send({
        to: email,
        channel: 'email',
        template: 'message_received',
        vars: {
          listingAddress: input.listingTitle,
          preview: previewFor(input.body, input.verdict) ?? '',
          link: `${this.#origin.replace(/\/+$/, '')}/messages/${input.threadId}`,
        },
        category: 'transactional',
        userId: input.recipientId,
        // Keyed on the message, so a retry of the same send cannot deliver a
        // second copy.
        idempotencyKey: idempotencyKeyFor({
          template: 'message_received',
          destination: email,
          discriminator: input.messageId,
        }),
      });
    } catch {
      // A notification failure must not fail the send. The message is already
      // written and visible in the recipient's inbox; the email is a nudge.
    }
  }

  // ── staff review of withheld messages ─────────────────────────────────────

  /**
   * Reads a message a moderator is deciding on, withheld ones included.
   *
   * Every other read path in this file filters on `delivered_at IS NOT NULL`.
   * This is the one that does not, which is the whole reason it exists: a
   * blocked message is invisible to its recipient and unknown to everyone
   * except the sender, so without a staff view there is no one who can see
   * that the heuristic got it wrong.
   *
   * The surrounding thread comes with it, because the same sentence means
   * different things in message one and message ten — and that is exactly the
   * judgement the scanner made and a human is now checking.
   */
  async reviewMessage(messageId: string, viewer: StaffViewer): Promise<{
    id: string;
    body: string;
    verdict: string;
    flaggedReasons: string[];
    delivered: boolean;
    isFirstContact: boolean;
    createdAt: Date;
    sender: { id: string; email: string; emailVerified: boolean; blockedCount: number };
    recipient: { id: string; email: string };
    listing: { id: string; title: string };
    /** Delivered messages around it, oldest first. */
    context: MessageView[];
  }> {
    const res = await this.#db.query<{
      id: string; thread_id: string; sender_id: string; body: string;
      moderation_verdict: string; flagged_reasons: string[]; delivered_at: Date | null;
      is_first_contact: boolean; created_at: Date;
      owner_id: string; inquirer_id: string; listing_id: string; listing_title: string;
      sender_email: string; sender_verified: Date | null;
    }>(
      `SELECT m.id, m.thread_id, m.sender_id, m.body, m.moderation_verdict,
              m.flagged_reasons, m.delivered_at, m.is_first_contact, m.created_at,
              t.owner_id, t.inquirer_id, t.listing_id,
              l.title AS listing_title,
              u.email AS sender_email, u.email_verified_at AS sender_verified
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
         JOIN listings l ON l.id = t.listing_id
         JOIN users u ON u.id = m.sender_id
        WHERE m.id = $1`,
      [messageId],
    );
    const row = res.rows[0];
    if (!row) throw notFound('Message not found.');

    const recipientId = row.sender_id === row.owner_id ? row.inquirer_id : row.owner_id;
    const recipient = await this.#db.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1',
      [recipientId],
    );

    // Prior blocks by this sender. A first offence and a fourth are different
    // decisions, and the number is the difference.
    const priors = await this.#db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM messages
        WHERE sender_id = $1 AND moderation_verdict = 'block' AND id <> $2`,
      [row.sender_id, messageId],
    );

    const context = await this.#db.query<{
      id: string; sender_id: string; body: string; kind: string;
      created_at: Date; moderation_verdict: string;
    }>(
      `SELECT id, sender_id, body, kind, created_at, moderation_verdict
         FROM messages
        WHERE thread_id = $1 AND delivered_at IS NOT NULL
        ORDER BY created_at
        LIMIT 40`,
      [row.thread_id],
    );

    return {
      id: row.id,
      body: row.body,
      verdict: row.moderation_verdict,
      flaggedReasons: row.flagged_reasons,
      delivered: row.delivered_at !== null,
      isFirstContact: row.is_first_contact,
      createdAt: row.created_at,
      sender: {
        id: row.sender_id,
        email: row.sender_email,
        emailVerified: row.sender_verified !== null,
        blockedCount: Number(priors.rows[0]?.n ?? 0),
      },
      recipient: { id: recipientId, email: recipient.rows[0]?.email ?? '' },
      listing: { id: row.listing_id, title: row.listing_title },
      context: context.rows.map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        body: m.body,
        kind: m.kind,
        createdAt: m.created_at,
        flagged: m.moderation_verdict === 'flag',
        mine: false,
      })),
    };
  }

  /**
   * Delivers a message the scanner withheld.
   *
   * This is the other half of blocking. `#post` refuses delivery on a verdict
   * and tells nobody; without a way to undo that, an honest sender whose
   * wording tripped a rule is silently censored and has no route to anyone who
   * could look. Release is that route.
   *
   * The message is delivered as of NOW rather than backdated to when it was
   * written: the recipient is seeing it for the first time, and a message that
   * appears three days up the thread is one they will never notice.
   */
  async release(messageId: string, viewer: StaffViewer): Promise<{ delivered: boolean }> {
    const now = this.#now();

    const outcome = await this.#db.transaction(async (tx) => {
      const res = await tx.query<{
        id: string; thread_id: string; sender_id: string; body: string;
        moderation_verdict: string; delivered_at: Date | null;
        owner_id: string; inquirer_id: string; listing_title: string;
      }>(
        `SELECT m.id, m.thread_id, m.sender_id, m.body, m.moderation_verdict,
                m.delivered_at, t.owner_id, t.inquirer_id, l.title AS listing_title
           FROM messages m
           JOIN threads t ON t.id = m.thread_id
           JOIN listings l ON l.id = t.listing_id
          WHERE m.id = $1
          FOR UPDATE OF m`,
        [messageId],
      );
      const row = res.rows[0];
      if (!row) throw notFound('Message not found.');
      if (row.delivered_at !== null) {
        // Already through. Releasing twice would double-count the thread and
        // send a second notification for one message.
        throw conflict('That message has already been delivered.');
      }

      await tx.query(
        `UPDATE messages
            SET delivered_at = $2, moderation_verdict = 'allow'
          WHERE id = $1`,
        [messageId, now],
      );
      await tx.query(
        `UPDATE threads
            SET last_at = $2, message_count = message_count + 1
          WHERE id = $1`,
        [row.thread_id, now],
      );
      await tx.query(
        `UPDATE moderation_queue
            SET state = 'approved', decided_by = $2, decided_at = now()
          WHERE subject_type = 'message' AND subject_id = $1 AND state = 'open'`,
        [messageId, viewer.userId],
      );

      await this.#audit?.record(tx, {
        actorId: viewer.userId,
        actorRole: viewer.role,
        action: 'message.release',
        subject: 'message',
        subjectId: messageId,
        before: { verdict: row.moderation_verdict, delivered: false },
        after: { verdict: 'allow', delivered: true },
        ip: viewer.ip,
      });

      const recipientId = row.sender_id === row.owner_id ? row.inquirer_id : row.owner_id;
      return { recipientId, listingTitle: row.listing_title, threadId: row.thread_id, body: row.body };
    });

    // Notify outside the transaction: a mail failure must not roll back a
    // decision a human already made.
    await this.#notifyRecipient({
      recipientId: outcome.recipientId,
      threadId: outcome.threadId,
      listingTitle: outcome.listingTitle,
      body: outcome.body,
      verdict: 'allow',
      messageId,
    });

    return { delivered: true };
  }

  /**
   * Confirms a block was right. The message stays undelivered; the queue entry
   * closes so the same decision is not made twice.
   */
  async uphold(messageId: string, viewer: StaffViewer): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const res = await tx.query<{ id: string; moderation_verdict: string; delivered_at: Date | null }>(
        'SELECT id, moderation_verdict, delivered_at FROM messages WHERE id = $1 FOR UPDATE',
        [messageId],
      );
      const row = res.rows[0];
      if (!row) throw notFound('Message not found.');
      if (row.delivered_at !== null) {
        throw conflict('That message was delivered and cannot be withheld now.');
      }

      await tx.query(
        `UPDATE moderation_queue
            SET state = 'rejected', decided_by = $2, decided_at = now()
          WHERE subject_type = 'message' AND subject_id = $1 AND state = 'open'`,
        [messageId, viewer.userId],
      );

      await this.#audit?.record(tx, {
        actorId: viewer.userId,
        actorRole: viewer.role,
        action: 'message.uphold',
        subject: 'message',
        subjectId: messageId,
        before: { verdict: row.moderation_verdict },
        after: { verdict: row.moderation_verdict, upheld: true },
        ip: viewer.ip,
      });
    });
  }

  // ── reading ───────────────────────────────────────────────────────────────

  /**
   * The inbox: every thread the caller is party to, either side.
   *
   * One query. The unread count is computed in SQL against the caller's own
   * read timestamp rather than by loading messages, because an inbox that
   * fetches every thread's messages to count them is the classic way a
   * fast page becomes a slow one at fifty threads.
   */
  async listThreads(
    userId: string,
    opts: { status?: ThreadStatus; limit?: number; offset?: number } = {},
  ): Promise<ThreadSummary[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);

    const res = await this.#db.query<{
      id: string; listing_id: string; listing_title: string; listing_status: string;
      owner_id: string; inquirer_id: string; status: ThreadStatus;
      message_count: number; last_at: Date; blocked_by: string | null;
      read_at: Date | null; unread: string; last_body: string | null;
      last_verdict: string | null;
    }>(
      `SELECT t.id, t.listing_id, l.title AS listing_title, l.status AS listing_status,
              t.owner_id, t.inquirer_id, t.status, t.message_count, t.last_at,
              t.blocked_by,
              CASE WHEN t.owner_id = $1 THEN t.owner_read_at ELSE t.inquirer_read_at END AS read_at,
              (SELECT count(*)::text FROM messages m
                WHERE m.thread_id = t.id
                  AND m.delivered_at IS NOT NULL
                  AND m.sender_id <> $1
                  AND (
                    CASE WHEN t.owner_id = $1 THEN t.owner_read_at ELSE t.inquirer_read_at END
                    IS NULL
                    OR m.created_at >
                       CASE WHEN t.owner_id = $1 THEN t.owner_read_at ELSE t.inquirer_read_at END
                  )) AS unread,
              last_msg.body AS last_body,
              last_msg.moderation_verdict AS last_verdict
         FROM threads t
         JOIN listings l ON l.id = t.listing_id
         LEFT JOIN LATERAL (
           SELECT body, moderation_verdict
             FROM messages
            WHERE thread_id = t.id AND delivered_at IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 1
         ) last_msg ON true
        WHERE (t.owner_id = $1 OR t.inquirer_id = $1)
          AND ($4::text IS NULL OR t.status = $4)
        ORDER BY t.last_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset, opts.status ?? null],
    );

    return res.rows.map((r) => this.#toSummary(r, userId));
  }

  /** Total unread across every thread. Drives the badge in the header. */
  async unreadCount(userId: string): Promise<number> {
    const res = await this.#db.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM messages m
         JOIN threads t ON t.id = m.thread_id
        WHERE (t.owner_id = $1 OR t.inquirer_id = $1)
          AND t.status <> 'blocked'
          AND m.delivered_at IS NOT NULL
          AND m.sender_id <> $1
          AND (
            CASE WHEN t.owner_id = $1 THEN t.owner_read_at ELSE t.inquirer_read_at END IS NULL
            OR m.created_at >
               CASE WHEN t.owner_id = $1 THEN t.owner_read_at ELSE t.inquirer_read_at END
          )`,
      [userId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * A thread with its messages, marking it read for the caller.
   *
   * Only delivered messages are returned, so a blocked one is invisible to
   * the recipient — including the fact that it was ever attempted.
   */
  async getThread(threadId: string, userId: string): Promise<ThreadDetail> {
    const thread = await this.#loadThread(threadId, userId);
    const isOwner = thread.owner_id === userId;

    const listing = await this.#db.query<{ title: string; status: string }>(
      'SELECT title, status FROM listings WHERE id = $1',
      [thread.listing_id],
    );

    const msgs = await this.#db.query<{
      id: string; sender_id: string; body: string; kind: string;
      created_at: Date; moderation_verdict: string;
    }>(
      `SELECT id, sender_id, body, kind, created_at, moderation_verdict
         FROM messages
        WHERE thread_id = $1 AND delivered_at IS NOT NULL
        ORDER BY created_at
        LIMIT 500`,
      [threadId],
    );

    await this.markRead(threadId, userId);

    return {
      ...this.#toSummary({
        id: thread.id,
        listing_id: thread.listing_id,
        listing_title: listing.rows[0]?.title ?? '',
        listing_status: listing.rows[0]?.status ?? '',
        owner_id: thread.owner_id,
        inquirer_id: thread.inquirer_id,
        status: thread.status,
        message_count: thread.message_count,
        last_at: thread.last_at,
        blocked_by: thread.blocked_by,
        read_at: isOwner ? thread.owner_read_at : thread.inquirer_read_at,
        unread: '0',
        last_body: null,
        last_verdict: null,
      }, userId),
      messages: msgs.rows.map((m) => ({
        id: m.id,
        senderId: m.sender_id,
        body: m.body,
        kind: m.kind,
        createdAt: m.created_at,
        flagged: m.moderation_verdict === 'flag',
        mine: m.sender_id === userId,
      })),
    };
  }

  async markRead(threadId: string, userId: string): Promise<void> {
    // The column updated depends on which side the caller is, and the WHERE
    // clause is what proves they are a party at all.
    await this.#db.query(
      `UPDATE threads
          SET owner_read_at    = CASE WHEN owner_id = $2 THEN now() ELSE owner_read_at END,
              inquirer_read_at = CASE WHEN inquirer_id = $2 THEN now() ELSE inquirer_read_at END
        WHERE id = $1 AND (owner_id = $2 OR inquirer_id = $2)`,
      [threadId, userId],
    );
  }

  // ── thread state ──────────────────────────────────────────────────────────

  async archive(threadId: string, userId: string, archived = true): Promise<void> {
    const thread = await this.#loadThread(threadId, userId);
    if (thread.status === 'blocked') {
      throw conflict('Unblock this conversation before changing it.');
    }
    await this.#db.query(
      `UPDATE threads SET status = $2 WHERE id = $1`,
      [threadId, archived ? 'archived' : 'open'],
    );
  }

  /**
   * Stops a conversation.
   *
   * Either party may block. The block records WHO, because that decides who
   * may lift it: being able to unblock yourself would make the feature
   * decorative.
   */
  async block(threadId: string, userId: string): Promise<void> {
    const thread = await this.#loadThread(threadId, userId);
    if (thread.status === 'blocked') return;   // idempotent
    await this.#db.query(
      `UPDATE threads SET status = 'blocked', blocked_by = $2, blocked_at = now()
        WHERE id = $1`,
      [threadId, userId],
    );
  }

  async unblock(threadId: string, userId: string): Promise<void> {
    const thread = await this.#loadThread(threadId, userId);
    if (thread.status !== 'blocked') return;
    if (thread.blocked_by !== userId) {
      // The blocked party must not learn they were blocked, so this reads as
      // the same generic failure they would get from posting.
      throw sendUnavailable();
    }
    await this.#db.query(
      `UPDATE threads SET status = 'open', blocked_by = NULL, blocked_at = NULL
        WHERE id = $1`,
      [threadId],
    );
  }

  /** Enquiries against one listing, for the owner's listing page. */
  async threadsForListing(listingId: string, ownerId: string): Promise<ThreadSummary[]> {
    const owned = await this.#db.query<{ id: string }>(
      'SELECT id FROM listings WHERE id = $1 AND owner_id = $2',
      [listingId, ownerId],
    );
    if (owned.rowCount === 0) throw notFound('Listing not found.');

    const res = await this.#db.query<{
      id: string; listing_id: string; listing_title: string; listing_status: string;
      owner_id: string; inquirer_id: string; status: ThreadStatus;
      message_count: number; last_at: Date; blocked_by: string | null;
      read_at: Date | null; unread: string; last_body: string | null; last_verdict: string | null;
    }>(
      `SELECT t.id, t.listing_id, l.title AS listing_title, l.status AS listing_status,
              t.owner_id, t.inquirer_id, t.status, t.message_count, t.last_at,
              t.blocked_by, t.owner_read_at AS read_at,
              '0'::text AS unread, NULL::text AS last_body, NULL::text AS last_verdict
         FROM threads t
         JOIN listings l ON l.id = t.listing_id
        WHERE t.listing_id = $1
        ORDER BY t.last_at DESC
        LIMIT 200`,
      [listingId],
    );
    return res.rows.map((r) => this.#toSummary(r, ownerId));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Resolves a thread the caller is party to, or reports it absent. */
  async #loadThread(threadId: string, userId: string): Promise<ThreadRow> {
    const res = await this.#db.query<ThreadRow>(
      `SELECT id, listing_id, owner_id, inquirer_id, status, message_count,
              last_at, owner_read_at, inquirer_read_at, blocked_by
         FROM threads WHERE id = $1`,
      [threadId],
    );
    const row = res.rows[0];
    // A stranger gets the same answer for a thread that exists as for one
    // that does not. 403 here would confirm two named people are talking
    // about a property.
    if (!row || (row.owner_id !== userId && row.inquirer_id !== userId)) {
      throw notFound('Conversation not found.');
    }
    return row;
  }

  #assertCanPost(thread: ThreadRow, senderId: string): void {
    if (thread.status === 'blocked') {
      // Identical whoever asks. The person who blocked knows why; the person
      // who was blocked must not be able to tell the difference between that
      // and simply being ignored.
      throw sendUnavailable();
    }
    if (thread.owner_id !== senderId && thread.inquirer_id !== senderId) {
      throw notFound('Conversation not found.');
    }
  }

  #toSummary(r: {
    id: string; listing_id: string; listing_title: string; listing_status: string;
    owner_id: string; inquirer_id: string; status: ThreadStatus;
    message_count: number; last_at: Date; blocked_by: string | null;
    read_at: Date | null; unread: string; last_body: string | null; last_verdict: string | null;
  }, userId: string): ThreadSummary {
    const isOwner = r.owner_id === userId;
    return {
      id: r.id,
      listingId: r.listing_id,
      listingTitle: r.listing_title,
      listingStatus: r.listing_status,
      counterpartyId: isOwner ? r.inquirer_id : r.owner_id,
      status: r.status,
      role: isOwner ? 'owner' : 'inquirer',
      messageCount: r.message_count,
      unreadCount: Number(r.unread ?? 0),
      lastAt: r.last_at,
      // A flagged message is not previewed in a list either — the same reason
      // it is not previewed in an email.
      lastPreview: r.last_verdict === 'allow' && r.last_body
        ? previewFor(r.last_body, 'allow', 100)
        : null,
      blockedByMe: r.blocked_by === userId,
    };
  }
}

/**
 * The single failure a blocked sender sees.
 *
 * 403 with a fixed message and no detail, so the same response is produced
 * whether the thread is blocked, was never theirs, or has been archived away.
 */
function sendUnavailable() {
  return forbidden('This conversation is no longer accepting messages.');
}

export { ESTABLISHED_AFTER };
