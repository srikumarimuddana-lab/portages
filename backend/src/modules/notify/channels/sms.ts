/**
 * SMS via AWS End User Messaging (SMS Voice v2).
 *
 * Note the service name: SMS billing moved off the SNS bill to AWS End User
 * Messaging on 2024-11-01. Guides that point at SNS for SMS predate that.
 *
 * SMS is the one channel where a runaway loop costs real money per message,
 * which is why the service layer puts it behind a kill switch.
 */
import { signRequest, type AwsCredentials } from '../../../lib/awssig.js';
import { ChannelError, NotConfiguredError, isRetryableStatus, type NotificationChannel, type Receipt, type SendRequest } from './types.js';
import type { Channel } from '../consent.js';

export interface SmsChannelConfig {
  region: string;
  credentials: AwsCredentials;
  /** Phone number ID, pool ID or sender ID registered with AWS. */
  originationIdentity: string;
  fetchImpl?: typeof fetch;
}

/** GSM-7 single segment. Longer messages split and bill per segment. */
export const SMS_SEGMENT_CHARS = 160;

export class SmsChannel implements NotificationChannel {
  readonly kind: Channel = 'sms';
  readonly #cfg: SmsChannelConfig | null;
  readonly #fetch: typeof fetch;

  constructor(cfg: SmsChannelConfig | null) {
    this.#cfg = cfg;
    this.#fetch = cfg?.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return this.#cfg !== null;
  }

  async send(req: SendRequest): Promise<Receipt> {
    const cfg = this.#cfg;
    if (!cfg) throw new NotConfiguredError('sms');

    if (!isE164(req.to)) {
      // Not retryable: the number will not become valid on a second attempt.
      throw new ChannelError('Destination is not a valid E.164 phone number.', {
        retryable: false,
      });
    }

    const host = `sms-voice.${cfg.region}.amazonaws.com`;
    const body = JSON.stringify({
      DestinationPhoneNumber: req.to,
      OriginationIdentity: cfg.originationIdentity,
      MessageBody: req.text,
      MessageType: 'TRANSACTIONAL',
      // AWS deduplicates on this, so a retry cannot double-send.
      ClientToken: req.idempotencyKey.slice(0, 64),
    });

    const signed = signRequest({
      method: 'POST',
      host,
      path: '/v1/sms-voice/messages',
      headers: { 'content-type': 'application/json' },
      body,
      service: 'sms-voice',
      region: cfg.region,
      credentials: cfg.credentials,
    });

    let res: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      res = await this.#fetch(signed.url, {
        method: 'POST',
        headers: signed.headers,
        body: signed.body,
      } as never) as never;
    } catch (err) {
      throw new ChannelError(`SMS request failed: ${String(err)}`, { retryable: true });
    }

    const payload = (await res.json().catch(() => ({}))) as {
      MessageId?: string; message?: string; __type?: string;
    };

    if (!res.ok) {
      throw new ChannelError(payload.message ?? `SMS API returned ${res.status}`, {
        retryable: isRetryableStatus(res.status),
        providerCode: payload.__type,
      });
    }
    if (!payload.MessageId) {
      throw new ChannelError('SMS API returned no MessageId', { retryable: false });
    }
    return { providerMessageId: payload.MessageId };
  }
}

/** E.164: a leading +, then 2-15 digits with no separators. */
export function isE164(n: string): boolean {
  return /^\+[1-9]\d{1,14}$/.test(n);
}

/** How many segments a message will bill as. */
export function segmentCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / SMS_SEGMENT_CHARS));
}
