/**
 * The channel contract.
 *
 * One interface, several transports. This is what makes WhatsApp a drop-in
 * later rather than a rewrite: the service layer knows nothing about SES,
 * SNS or Meta, only about `send`.
 */
import type { Channel } from '../consent.js';

export interface SendRequest {
  to: string;
  subject?: string | undefined;
  text: string;
  html?: string | undefined;
  /** Threaded into provider metadata for correlation. */
  idempotencyKey: string;
}

export interface Receipt {
  providerMessageId: string;
}

export interface NotificationChannel {
  readonly kind: Channel;
  /** False when credentials are absent; the service then blocks rather than throws. */
  isConfigured(): boolean;
  send(req: SendRequest): Promise<Receipt>;
}

/** Distinguishes "try again" from "this will never work". */
export class ChannelError extends Error {
  readonly retryable: boolean;
  readonly providerCode: string | undefined;

  constructor(message: string, opts: { retryable: boolean; providerCode?: string | undefined }) {
    super(message);
    this.name = 'ChannelError';
    this.retryable = opts.retryable;
    this.providerCode = opts.providerCode;
  }
}

export class NotConfiguredError extends ChannelError {
  constructor(channel: string) {
    super(`The ${channel} channel is not configured.`, { retryable: false });
    this.name = 'NotConfiguredError';
  }
}

/**
 * Classifies a provider HTTP status.
 *
 * The distinction matters: retrying a 4xx burns quota and never succeeds,
 * while giving up on a 5xx or a throttle loses a message that would have
 * gone through a second later.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;           // throttled
  if (status === 408) return true;           // request timeout
  return status >= 500;
}

/** Exponential backoff with full jitter, capped. */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 5 * 60_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  // Full jitter: without it, a batch of failures retries in lockstep and
  // hammers a recovering provider at exactly the wrong moment.
  return Math.floor(Math.random() * exponential);
}
