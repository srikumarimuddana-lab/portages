/**
 * CASL consent gate.
 *
 * Canada's Anti-Spam Legislation carries penalties up to $10M per violation,
 * and the burden of proving consent sits with the sender. So consent is not a
 * boolean on a profile that some code path might forget to read: it is a
 * ledger, and every non-transactional send passes through this file.
 *
 * The categories are a legal distinction, not a product one:
 *
 *   transactional        A message the user's own action requires — an OTP, a
 *                        password reset, a booking confirmation. Exempt from
 *                        the consent requirement, but still needs sender
 *                        identification and an unsubscribe mechanism.
 *   saved_search_alert   The user asked to be told about new listings. That
 *                        is express consent, and it is revocable.
 *   marketing            Anything we send because WE want to. Requires
 *                        separate express consent — bundling it with an alert
 *                        opt-in does not count.
 */
import type { Sql } from '../../db/pool.js';

export type MessageCategory = 'transactional' | 'saved_search_alert' | 'marketing';
export type Channel = 'email' | 'sms' | 'whatsapp' | 'push';

export type ConsentVerdict =
  | { allowed: true; reason: 'transactional' | 'express_consent' }
  | { allowed: false; reason: ConsentDenial };

export type ConsentDenial =
  | 'no_consent_on_record'
  | 'consent_revoked'
  | 'consent_expired'
  | 'suppressed'
  | 'user_preference_off';

export interface ConsentRow {
  kind: string;
  channel: string;
  grantedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Pure decision, separated from the query so it can be tested exhaustively.
 * Note the ordering: suppression beats consent. Someone who marked us as spam
 * does not get mail because a stale consent row exists.
 */
export function decideConsent(input: {
  category: MessageCategory;
  channel: Channel;
  consents: ConsentRow[];
  suppressed: boolean;
  preferenceEnabled?: boolean | undefined;
  now?: Date;
}): ConsentVerdict {
  const now = input.now ?? new Date();

  if (input.suppressed) return { allowed: false, reason: 'suppressed' };

  // Transactional messages are exempt from express consent — but NOT from
  // suppression, which is why that check comes first.
  if (input.category === 'transactional') {
    return { allowed: true, reason: 'transactional' };
  }

  // A user preference toggle is a softer control than consent, but it still
  // means no.
  if (input.preferenceEnabled === false) {
    return { allowed: false, reason: 'user_preference_off' };
  }

  const matching = input.consents.filter(
    (c) => c.kind === input.category && c.channel === input.channel,
  );
  if (matching.length === 0) return { allowed: false, reason: 'no_consent_on_record' };

  // Any live consent permits the send; report the most specific failure when
  // none is live, so operators can tell "never opted in" from "opted out".
  let sawRevoked = false;
  let sawExpired = false;
  for (const c of matching) {
    if (c.revokedAt && c.revokedAt <= now) {
      sawRevoked = true;
      continue;
    }
    if (c.expiresAt && c.expiresAt <= now) {
      sawExpired = true;
      continue;
    }
    return { allowed: true, reason: 'express_consent' };
  }
  if (sawRevoked) return { allowed: false, reason: 'consent_revoked' };
  if (sawExpired) return { allowed: false, reason: 'consent_expired' };
  return { allowed: false, reason: 'no_consent_on_record' };
}

/** Message shown to an operator inspecting a blocked delivery. */
export function explainDenial(reason: ConsentDenial): string {
  switch (reason) {
    case 'no_consent_on_record':
      return 'No express consent recorded for this category and channel.';
    case 'consent_revoked':
      return 'The recipient withdrew consent.';
    case 'consent_expired':
      return 'The recorded consent has expired.';
    case 'suppressed':
      return 'This destination is suppressed (bounce, complaint or unsubscribe).';
    case 'user_preference_off':
      return 'The recipient turned this notification off in their preferences.';
  }
}

export class ConsentService {
  readonly #db: Sql;

  constructor(db: Sql) {
    this.#db = db;
  }

  /** Looks up everything the decision needs, then applies it. */
  async check(input: {
    userId: string | null;
    destination: string;
    channel: Channel;
    category: MessageCategory;
    prefKind?: string | undefined;
  }): Promise<ConsentVerdict> {
    const suppressed = await this.isSuppressed(input.destination, input.channel);

    if (input.category === 'transactional' || !input.userId) {
      return decideConsent({
        category: input.category,
        channel: input.channel,
        consents: [],
        suppressed,
      });
    }

    const { rows } = await this.#db.query<{
      kind: string; channel: string;
      granted_at: Date; expires_at: Date | null; revoked_at: Date | null;
    }>(
      `SELECT kind, channel, granted_at, expires_at, revoked_at
         FROM consents WHERE user_id = $1 AND kind = $2 AND channel = $3`,
      [input.userId, input.category, input.channel],
    );

    let preferenceEnabled: boolean | undefined;
    if (input.prefKind) {
      const pref = await this.#db.query<{ enabled: boolean }>(
        'SELECT enabled FROM notification_prefs WHERE user_id = $1 AND kind = $2 AND channel = $3',
        [input.userId, input.prefKind, input.channel],
      );
      preferenceEnabled = pref.rows[0]?.enabled;
    }

    return decideConsent({
      category: input.category,
      channel: input.channel,
      suppressed,
      preferenceEnabled,
      consents: rows.map((r) => ({
        kind: r.kind,
        channel: r.channel,
        grantedAt: r.granted_at,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at,
      })),
    });
  }

  async isSuppressed(destination: string, channel: Channel): Promise<boolean> {
    const { rowCount } = await this.#db.query(
      'SELECT 1 FROM suppressions WHERE destination = $1 AND channel = $2',
      [destination.toLowerCase(), channel],
    );
    return rowCount > 0;
  }

  /**
   * Records a bounce, complaint or unsubscribe. Idempotent, because provider
   * webhooks retry and may deliver the same event more than once.
   */
  async suppress(
    destination: string,
    channel: Channel,
    reason: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual' | 'invalid',
    detail?: string,
  ): Promise<void> {
    await this.#db.query(
      `INSERT INTO suppressions(destination, channel, reason, detail)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (destination, channel) DO NOTHING`,
      [destination.toLowerCase(), channel, reason, detail ?? null],
    );
  }

  /** Records express consent, with evidence of how it was obtained. */
  async grant(input: {
    userId: string;
    kind: MessageCategory;
    channel: Channel;
    evidence: Record<string, unknown>;
    expiresAt?: Date | undefined;
  }): Promise<string> {
    const { rows } = await this.#db.query<{ id: string }>(
      `INSERT INTO consents(user_id, kind, channel, method, evidence, expires_at)
       VALUES ($1,$2,$3,'express_optin',$4,$5)
       RETURNING id`,
      [input.userId, input.kind, input.channel, JSON.stringify(input.evidence), input.expiresAt ?? null],
    );
    return rows[0]!.id;
  }

  /** Withdrawal must be honoured promptly; CASL allows no grace period. */
  async revoke(userId: string, kind: MessageCategory, channel: Channel): Promise<void> {
    await this.#db.query(
      `UPDATE consents SET revoked_at = now()
        WHERE user_id = $1 AND kind = $2 AND channel = $3 AND revoked_at IS NULL`,
      [userId, kind, channel],
    );
  }
}
