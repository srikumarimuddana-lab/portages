/**
 * WhatsApp — deliberately unimplemented.
 *
 * The interface exists so adding WhatsApp later is an adapter rather than a
 * refactor, but the body throws. Reasons, recorded so the decision can be
 * revisited on evidence rather than vibes:
 *
 *  - Canadian users reach for SMS, email and iMessage. WhatsApp's dominance
 *    in markets like India (where NoBroker relies on it) does not transfer.
 *  - Meta bills roughly USD $0.025 per delivered template message; only
 *    replies inside a 24-hour user-initiated window are free.
 *  - Sending at all requires Meta Business Verification, which is a review
 *    queue measured in weeks.
 *
 * Implement when Regina users actually ask for it. Everything else is ready.
 */
import { NotConfiguredError, type NotificationChannel, type Receipt, type SendRequest } from './types.js';
import type { Channel } from '../consent.js';

export class WhatsAppChannel implements NotificationChannel {
  readonly kind: Channel = 'whatsapp';

  isConfigured(): boolean {
    return false;
  }

  async send(_req: SendRequest): Promise<Receipt> {
    throw new NotConfiguredError('whatsapp');
  }
}
