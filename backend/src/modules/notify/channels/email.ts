/**
 * Email via Amazon SES v2.
 *
 * Run this in ca-central-1: SES pricing is uniform across regions, so there
 * is no reason to put Canadian users' addresses — or the bounce data that
 * describes them — outside Canada.
 */
import { signRequest, type AwsCredentials } from '../../../lib/awssig.js';
import { ChannelError, NotConfiguredError, isRetryableStatus, type NotificationChannel, type Receipt, type SendRequest } from './types.js';
import type { Channel } from '../consent.js';

export interface EmailChannelConfig {
  region: string;
  credentials: AwsCredentials;
  /** Verified sender, e.g. "Portage <no-reply@portage.ca>" */
  fromAddress: string;
  /** SES configuration set carrying the bounce/complaint event destination. */
  configurationSet?: string | undefined;
  fetchImpl?: typeof fetch;
}

export class EmailChannel implements NotificationChannel {
  readonly kind: Channel = 'email';
  readonly #cfg: EmailChannelConfig | null;
  readonly #fetch: typeof fetch;

  constructor(cfg: EmailChannelConfig | null) {
    this.#cfg = cfg;
    this.#fetch = cfg?.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return this.#cfg !== null;
  }

  async send(req: SendRequest): Promise<Receipt> {
    const cfg = this.#cfg;
    if (!cfg) throw new NotConfiguredError('email');

    const host = `email.${cfg.region}.amazonaws.com`;
    const path = '/v2/email/outbound-emails';

    const body = JSON.stringify({
      FromEmailAddress: cfg.fromAddress,
      Destination: { ToAddresses: [req.to] },
      Content: {
        Simple: {
          Subject: { Data: req.subject ?? '', Charset: 'UTF-8' },
          Body: {
            // Always send a text alternative: some clients refuse HTML-only
            // mail, and spam filters treat it as a signal.
            Text: { Data: req.text, Charset: 'UTF-8' },
            ...(req.html ? { Html: { Data: req.html, Charset: 'UTF-8' } } : {}),
          },
        },
      },
      ...(cfg.configurationSet ? { ConfigurationSetName: cfg.configurationSet } : {}),
      EmailTags: [{ Name: 'idempotency', Value: req.idempotencyKey.slice(0, 256) }],
    });

    const signed = signRequest({
      method: 'POST',
      host,
      path,
      headers: { 'content-type': 'application/json' },
      body,
      service: 'ses',
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
      // Network failures are always worth another attempt.
      throw new ChannelError(`SES request failed: ${String(err)}`, { retryable: true });
    }

    const payload = (await res.json().catch(() => ({}))) as {
      MessageId?: string; message?: string; __type?: string;
    };

    if (!res.ok) {
      throw new ChannelError(payload.message ?? `SES returned ${res.status}`, {
        retryable: isRetryableStatus(res.status),
        providerCode: payload.__type,
      });
    }
    if (!payload.MessageId) {
      throw new ChannelError('SES accepted the request but returned no MessageId', {
        retryable: false,
      });
    }
    return { providerMessageId: payload.MessageId };
  }
}
