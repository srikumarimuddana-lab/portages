/**
 * The notification service.
 *
 * Everything outbound goes through `send()`. The order of checks is the whole
 * point of this file:
 *
 *   1. Kill switch      — an operator can stop a channel dead without a deploy
 *   2. Idempotency      — a retry of the same logical message is a no-op
 *   3. Consent          — CASL, enforced in code and not in a policy document
 *   4. Channel send     — the only step that talks to a provider
 *
 * Consent is checked AFTER idempotency so that a duplicate call cannot be
 * used to probe whether someone has opted in, and BEFORE the provider so a
 * message without consent never leaves the building.
 *
 * Delivery is recorded whatever happens. A blocked send is a row with status
 * 'blocked' and the reason — which is what lets you answer "why didn't this
 * user get their alert?" without guessing.
 */
import { randomUUID, createHash } from 'node:crypto';
import { ConsentService, explainDenial, type Channel, type MessageCategory } from './consent.js';
import { ChannelError, backoffMs, type NotificationChannel } from './channels/types.js';
import { renderTemplate, type TemplateId, type TemplateVars } from './templates.js';
import type { Sql } from '../../db/pool.js';

export interface SendInput {
  to: string;
  channel: Channel;
  template: TemplateId;
  vars: TemplateVars;
  category: MessageCategory;
  userId?: string | null | undefined;
  /**
   * Supply a stable key for anything that could be retried. Two calls with
   * the same key send once. Omitted, a random key is used — correct only for
   * genuinely one-off sends.
   */
  idempotencyKey?: string | undefined;
  prefKind?: string | undefined;
  sendAfter?: Date | undefined;
}

export type SendResult =
  | { status: 'sent'; deliveryId: string; providerMessageId: string }
  | { status: 'duplicate'; deliveryId: string }
  | { status: 'blocked'; deliveryId: string; reason: string }
  | { status: 'queued'; deliveryId: string }
  | { status: 'failed'; deliveryId: string; reason: string; retryable: boolean };

/** Reads a kill switch. Wired to the flags module in WS4. */
export interface KillSwitch {
  isChannelEnabled(channel: Channel): Promise<boolean>;
}

/** Everything on by default until the flags module lands. */
export const ALLOW_ALL: KillSwitch = { async isChannelEnabled() { return true; } };

export const MAX_ATTEMPTS = 5;

export class NotifyService {
  readonly #db: Sql;
  readonly #consent: ConsentService;
  readonly #channels: Map<Channel, NotificationChannel>;
  readonly #switch: KillSwitch;

  constructor(
    db: Sql,
    channels: NotificationChannel[],
    opts: { killSwitch?: KillSwitch } = {},
  ) {
    this.#db = db;
    this.#consent = new ConsentService(db);
    this.#channels = new Map(channels.map((c) => [c.kind, c]));
    this.#switch = opts.killSwitch ?? ALLOW_ALL;
  }

  get consent(): ConsentService {
    return this.#consent;
  }

  async send(input: SendInput): Promise<SendResult> {
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const destination = normalizeDestination(input.to, input.channel);

    // 1. Kill switch, before any database work. This is the lever that stops
    //    a runaway loop at 2am without shipping code.
    if (!(await this.#switch.isChannelEnabled(input.channel))) {
      const id = await this.#record(input, destination, idempotencyKey, 'blocked', 'channel disabled by kill switch');
      return { status: 'blocked', deliveryId: id.deliveryId, reason: 'channel_disabled' };
    }

    // 2. Idempotency. The unique index on idempotency_key is the real guard;
    //    ON CONFLICT turns a race into a no-op rather than an error.
    const claimed = await this.#claim(input, destination, idempotencyKey);
    if (!claimed.isNew) {
      return { status: 'duplicate', deliveryId: claimed.deliveryId };
    }

    // 3. Consent.
    const verdict = await this.#consent.check({
      userId: input.userId ?? null,
      destination,
      channel: input.channel,
      category: input.category,
      prefKind: input.prefKind,
    });
    if (!verdict.allowed) {
      await this.#finish(claimed.deliveryId, 'blocked', { error: explainDenial(verdict.reason) });
      return { status: 'blocked', deliveryId: claimed.deliveryId, reason: verdict.reason };
    }

    // Scheduled sends stop here; the job runner picks them up.
    if (input.sendAfter && input.sendAfter > new Date()) {
      return { status: 'queued', deliveryId: claimed.deliveryId };
    }

    return this.#dispatch(claimed.deliveryId, input, destination, idempotencyKey);
  }

  /** Performs the provider call and records the outcome. */
  async #dispatch(
    deliveryId: string,
    input: SendInput,
    destination: string,
    idempotencyKey: string,
  ): Promise<SendResult> {
    const channel = this.#channels.get(input.channel);
    if (!channel || !channel.isConfigured()) {
      await this.#finish(deliveryId, 'failed', { error: `${input.channel} channel is not configured` });
      return {
        status: 'failed',
        deliveryId,
        reason: 'channel_not_configured',
        retryable: false,
      };
    }

    const rendered = renderTemplate(input.template, input.vars);

    try {
      const receipt = await channel.send({
        to: destination,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        idempotencyKey,
      });
      await this.#finish(deliveryId, 'sent', { providerMessageId: receipt.providerMessageId });
      return { status: 'sent', deliveryId, providerMessageId: receipt.providerMessageId };
    } catch (err) {
      const retryable = err instanceof ChannelError ? err.retryable : true;
      const message = err instanceof Error ? err.message : String(err);

      if (retryable) {
        // Leave it pending with a backoff so the job runner retries it.
        await this.#deferRetry(deliveryId, message);
        return { status: 'failed', deliveryId, reason: message, retryable: true };
      }
      await this.#finish(deliveryId, 'failed', { error: message });
      return { status: 'failed', deliveryId, reason: message, retryable: false };
    }
  }

  /**
   * Drains due deliveries. Called by the scheduled job runner; processes a
   * bounded batch so it always finishes inside a serverless function's
   * timeout however far behind the queue gets.
   */
  async processPending(limit = 50): Promise<{ sent: number; failed: number }> {
    const { rows } = await this.#db.query<{
      id: string; destination: string; channel: Channel; template: string;
      category: MessageCategory; user_id: string | null; idempotency_key: string;
      attempts: number;
    }>(
      `UPDATE notification_deliveries
          SET status = 'pending', attempts = attempts + 1, updated_at = now()
        WHERE id IN (
          SELECT id FROM notification_deliveries
           WHERE status = 'pending' AND send_after <= now() AND attempts < $2
           ORDER BY send_after, created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, destination, channel, template, category, user_id,
                  idempotency_key, attempts`,
      [limit, MAX_ATTEMPTS],
    );

    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      const result = await this.#dispatch(
        row.id,
        {
          to: row.destination,
          channel: row.channel,
          template: row.template as TemplateId,
          // Variables are not persisted; templates for queued sends must be
          // self-contained. Keeping user data out of the queue is deliberate.
          vars: {},
          category: row.category,
          userId: row.user_id,
        },
        row.destination,
        row.idempotency_key,
      );
      if (result.status === 'sent') sent += 1;
      else failed += 1;
    }
    return { sent, failed };
  }

  async #claim(
    input: SendInput,
    destination: string,
    idempotencyKey: string,
  ): Promise<{ deliveryId: string; isNew: boolean }> {
    const inserted = await this.#db.query<{ id: string }>(
      `INSERT INTO notification_deliveries
         (user_id, destination, channel, template, category, idempotency_key, send_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        input.userId ?? null,
        destination,
        input.channel,
        input.template,
        input.category,
        idempotencyKey,
        input.sendAfter ?? new Date(),
      ],
    );
    if (inserted.rows[0]) return { deliveryId: inserted.rows[0].id, isNew: true };

    const existing = await this.#db.query<{ id: string }>(
      'SELECT id FROM notification_deliveries WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    return { deliveryId: existing.rows[0]!.id, isNew: false };
  }

  async #record(
    input: SendInput,
    destination: string,
    idempotencyKey: string,
    status: string,
    error: string,
  ): Promise<{ deliveryId: string }> {
    const claimed = await this.#claim(input, destination, idempotencyKey);
    await this.#finish(claimed.deliveryId, status, { error });
    return { deliveryId: claimed.deliveryId };
  }

  async #finish(
    deliveryId: string,
    status: string,
    opts: { providerMessageId?: string; error?: string } = {},
  ): Promise<void> {
    await this.#db.query(
      `UPDATE notification_deliveries
          SET status = $2,
              provider_message_id = COALESCE($3, provider_message_id),
              last_error = $4,
              sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
        WHERE id = $1`,
      [deliveryId, status, opts.providerMessageId ?? null, opts.error ?? null],
    );
  }

  async #deferRetry(deliveryId: string, error: string): Promise<void> {
    await this.#db.query(
      `UPDATE notification_deliveries
          SET status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
              attempts = attempts + 1,
              last_error = $2,
              send_after = now() + make_interval(secs => $4)
        WHERE id = $1`,
      [deliveryId, error, MAX_ATTEMPTS, Math.ceil(backoffMs(1) / 1000)],
    );
  }
}

/**
 * Normalizes a destination so suppression lookups and idempotency behave.
 * Email is case-insensitive; phone numbers must already be E.164 and are
 * only stripped of formatting characters.
 */
export function normalizeDestination(to: string, channel: Channel): string {
  if (channel === 'email') return to.trim().toLowerCase();
  if (channel === 'sms' || channel === 'whatsapp') return to.replace(/[\s()-]/g, '');
  return to.trim();
}

/**
 * Builds a stable idempotency key from the things that identify a message.
 * Same inputs, same key — so a retried job sends once.
 */
export function idempotencyKeyFor(parts: {
  template: string;
  destination: string;
  /** Something that changes when the message legitimately should resend. */
  discriminator: string;
}): string {
  return createHash('sha256')
    .update(`${parts.template}\n${parts.destination}\n${parts.discriminator}`, 'utf8')
    .digest('base64url')
    .slice(0, 43);
}
