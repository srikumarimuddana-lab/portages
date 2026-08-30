/**
 * The user-facing OTP flows: verify an email address, and reset a password.
 *
 * These sit above OtpService and the notification layer, and they are where
 * the enumeration discipline lives. Every request endpoint returns the same
 * shape whether or not the account exists — otherwise "forgot password"
 * becomes a free tool for testing which of a breach dump's addresses have
 * Portage accounts.
 */
import { OtpService, type OtpChannel } from './service.js';
import { hashPassword } from '../../../lib/crypto.js';
import { validatePasswordStrength } from '../service.js';
import { badRequest, unauthorized, tooManyRequests } from '../../../lib/errors.js';
import { idempotencyKeyFor } from '../../notify/service.js';
import type { NotifyService } from '../../notify/service.js';
import type { AuthService } from '../service.js';
import type { Sql } from '../../../db/pool.js';

/** Identical for every request, so nothing leaks about account existence. */
export const REQUEST_ACK =
  'If that address is registered, a code is on its way. It expires in 10 minutes.';

export interface OtpFlowDeps {
  db: Sql;
  otp: OtpService;
  notify: NotifyService;
  auth: AuthService;
}

export class OtpFlows {
  readonly #db: Sql;
  readonly #otp: OtpService;
  readonly #notify: NotifyService;
  readonly #auth: AuthService;

  constructor(deps: OtpFlowDeps) {
    this.#db = deps.db;
    this.#otp = deps.otp;
    this.#notify = deps.notify;
    this.#auth = deps.auth;
  }

  // ── email verification ────────────────────────────────────────────────────

  /**
   * Sends a verification code to a signed-in user's address.
   *
   * This one CAN be specific about errors: the caller is authenticated, so
   * there is no account to enumerate.
   */
  async requestEmailVerification(userId: string): Promise<{ sent: boolean }> {
    const { rows } = await this.#db.query<{ email: string; email_verified_at: Date | null }>(
      'SELECT email, email_verified_at FROM users WHERE id = $1',
      [userId],
    );
    const user = rows[0];
    if (!user) throw unauthorized();
    if (user.email_verified_at) return { sent: false }; // already done

    const issued = await this.#otp.issue({
      identifier: user.email,
      channel: 'email',
      purpose: 'verify_email',
      userId,
    });

    await this.#notify.send({
      to: user.email,
      channel: 'email',
      template: 'otp_email',
      vars: { code: issued.code, minutes: 10 },
      category: 'transactional',
      userId,
      idempotencyKey: idempotencyKeyFor({
        template: 'otp_email',
        destination: user.email,
        discriminator: issued.challengeId,
      }),
    });

    return { sent: true };
  }

  /** Confirms the code and marks the address verified. */
  async confirmEmailVerification(userId: string, code: string): Promise<void> {
    const { rows } = await this.#db.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1',
      [userId],
    );
    const user = rows[0];
    if (!user) throw unauthorized();

    const result = await this.#otp.verify({
      identifier: user.email,
      channel: 'email',
      purpose: 'verify_email',
      code,
    });
    if (!result.ok) {
      throw result.reason === 'too_many_attempts'
        ? tooManyRequests('Too many incorrect attempts. Request a new code.')
        : unauthorized('That code is not valid. Request a new one and try again.');
    }

    // The challenge is bound to the user it was issued to. Without this, a
    // code mailed to one account could be redeemed while signed in as another.
    if (result.userId && result.userId !== userId) {
      throw unauthorized('That code is not valid. Request a new one and try again.');
    }

    await this.#db.query(
      'UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL',
      [userId],
    );
    await this.#db.query(
      `INSERT INTO verifications (user_id, kind, status, verified_at)
       VALUES ($1, 'email', 'passed', now())
       ON CONFLICT (user_id, kind)
       DO UPDATE SET status = 'passed', verified_at = now()`,
      [userId],
    );
  }

  // ── password reset ────────────────────────────────────────────────────────

  /**
   * Starts a password reset. Always reports success.
   *
   * The work done for an unknown address is deliberately similar to the work
   * done for a known one, so response timing does not become the oracle that
   * the response body is not.
   */
  async requestPasswordReset(email: string, channel: OtpChannel = 'email'): Promise<{ message: string }> {
    const normalized = email.trim().toLowerCase();
    const { rows } = await this.#db.query<{ id: string; status: string }>(
      'SELECT id, status FROM users WHERE email = $1',
      [normalized],
    );
    const user = rows[0];

    if (user && user.status === 'active') {
      const issued = await this.#otp.issue({
        identifier: normalized,
        channel,
        purpose: 'password_reset',
        userId: user.id,
      });
      await this.#notify.send({
        to: normalized,
        channel,
        template: channel === 'sms' ? 'otp_sms' : 'otp_email',
        vars: { code: issued.code, minutes: 10 },
        category: 'transactional',
        userId: user.id,
        idempotencyKey: idempotencyKeyFor({
          template: 'password_reset',
          destination: normalized,
          discriminator: issued.challengeId,
        }),
      });
    }

    return { message: REQUEST_ACK };
  }

  /**
   * Completes a reset: verify the code, set the new password, and cut every
   * other session.
   *
   * Revoking sessions is the point. If the reset was prompted by a
   * compromise, leaving the attacker's session alive makes the whole exercise
   * decorative.
   */
  async confirmPasswordReset(input: {
    email: string;
    code: string;
    newPassword: string;
    channel?: OtpChannel;
  }): Promise<void> {
    const normalized = input.email.trim().toLowerCase();
    const channel = input.channel ?? 'email';

    const strength = validatePasswordStrength(input.newPassword, normalized);
    if (strength.length > 0) {
      throw badRequest('Password does not meet requirements.', strength);
    }

    const result = await this.#otp.verify({
      identifier: normalized,
      channel,
      purpose: 'password_reset',
      code: input.code,
    });
    if (!result.ok) {
      throw result.reason === 'too_many_attempts'
        ? tooManyRequests('Too many incorrect attempts. Request a new code.')
        : unauthorized('That code is not valid. Request a new one and try again.');
    }
    if (!result.userId) {
      throw unauthorized('That code is not valid. Request a new one and try again.');
    }

    const passwordHash = await hashPassword(input.newPassword);
    await this.#db.query(
      `UPDATE users
          SET password_hash = $2, failed_logins = 0, locked_until = NULL
        WHERE id = $1`,
      [result.userId, passwordHash],
    );

    // Every session, including any the attacker holds. The user signs in again.
    await this.#auth.revokeAllSessions(result.userId);
  }
}
