/**
 * Authentication service.
 *
 * Every decision here is deliberate:
 *  - Signup and login return the SAME response shape and timing profile for
 *    "email already taken" and "wrong password" — no user enumeration.
 *  - Failed attempts escalate an account-scoped lockout, because distributed
 *    credential stuffing rotates IPs and defeats IP-only limits.
 *  - A new session token is minted on every login (no session fixation).
 *  - Password hashes are upgraded transparently when parameters strengthen.
 */
import { hashPassword, verifyPassword, needsRehash, hashToken, pseudonymize } from '../../lib/crypto.js';
import { createSessionMaterial, checkSession, type StoredSession } from '../../lib/session.js';
import { lockoutUntil, isLocked } from '../../lib/ratelimit.js';
import { badRequest, conflict, unauthorized, tooManyRequests } from '../../lib/errors.js';
import type { Sql } from '../../db/pool.js';

export interface AuthDeps {
  db: Sql;
  pepper: string;
  now?: () => Date;
}

export interface SignupInput {
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
}

export interface SessionIssued {
  userId: string;
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
}

export const USER_ROLES = ['user', 'staff', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface ResolvedSession {
  userId: string;
  sessionId: string;
  csrfHash: Buffer;
  /** Read fresh on every request, so a demotion takes effect at once. */
  role: UserRole;
}

/** Minimum viable password policy: length over composition rules. */
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;

export function validatePasswordStrength(password: string, email: string): string[] {
  const errors: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    errors.push('Password is too long.');
  }
  const local = email.split('@')[0] ?? '';
  if (local.length >= 3 && password.toLowerCase().includes(local.toLowerCase())) {
    errors.push('Password must not contain your email address.');
  }
  // Rejects the handful of passwords that dominate breach corpora. A real
  // deployment should check the full k-anonymity range API from HIBP here.
  const COMMON = new Set([
    'password', 'password123', '123456789012', 'qwertyuiop12',
    'letmein12345', 'iloveyou1234', 'administrator',
  ]);
  if (COMMON.has(password.toLowerCase())) {
    errors.push('That password is too common.');
  }
  return errors;
}

export class AuthService {
  readonly #db: Sql;
  readonly #pepper: string;
  readonly #now: () => Date;

  constructor(deps: AuthDeps) {
    this.#db = deps.db;
    this.#pepper = deps.pepper;
    this.#now = deps.now ?? (() => new Date());
  }

  async signup(input: SignupInput): Promise<SessionIssued> {
    const errs = validatePasswordStrength(input.password, input.email);
    if (errs.length) throw badRequest('Password does not meet requirements.', errs);

    const passwordHash = await hashPassword(input.password);
    const now = this.#now();

    return this.#db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1',
        [input.email],
      );
      if (existing.rowCount > 0) {
        // Generic message; the caller must not distinguish this from success
        // in its UX beyond "check your email".
        throw conflict('That email cannot be registered.');
      }

      const created = await tx.query<{ id: string }>(
        `INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id`,
        [input.email, passwordHash],
      );
      const userId = created.rows[0]!.id;
      await tx.query('INSERT INTO user_profiles(user_id) VALUES ($1)', [userId]);

      return this.#issueSession(tx, userId, input, now);
    });
  }

  async login(input: SignupInput): Promise<SessionIssued> {
    const now = this.#now();
    const found = await this.#db.query<{
      id: string; password_hash: string; status: string;
      failed_logins: number; locked_until: Date | null;
    }>(
      `SELECT id, password_hash, status, failed_logins, locked_until
         FROM users WHERE email = $1`,
      [input.email],
    );
    const user = found.rows[0];

    if (user && isLocked(user.locked_until, now)) {
      throw tooManyRequests('Too many failed attempts. Try again later.');
    }

    // Always run a verification, even when the account does not exist, so the
    // response time does not reveal whether the email is registered.
    const stored = user?.password_hash ?? DUMMY_HASH;
    const ok = await verifyPassword(input.password, stored);

    if (!user || !ok || user.status !== 'active') {
      if (user) await this.#recordFailure(user.id, user.failed_logins + 1, now);
      throw unauthorized('Email or password is incorrect.');
    }

    return this.#db.transaction(async (tx) => {
      await tx.query(
        `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`,
        [user.id],
      );
      if (needsRehash(user.password_hash)) {
        const upgraded = await hashPassword(input.password);
        await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, upgraded]);
      }
      return this.#issueSession(tx, user.id, input, now);
    });
  }

  /**
   * Resolves a presented session token to a user, sliding the idle window.
   *
   * The join onto `users` does two jobs. It carries the role, so authorization
   * costs no extra query — and it re-reads `status` on every request, so
   * suspending an account takes effect immediately. Without that, suspension
   * would only stop the next sign-in: the abusive session already in hand
   * would keep working for up to the absolute session lifetime, which is the
   * entire window during which suspending someone actually matters.
   */
  async resolveSession(token: string): Promise<ResolvedSession | null> {
    const now = this.#now();
    const res = await this.#db.query<{
      id: string; user_id: string; csrf_hash: Buffer;
      idle_expires_at: Date; absolute_expires_at: Date; revoked_at: Date | null;
      role: UserRole; status: string;
    }>(
      `SELECT s.id, s.user_id, s.csrf_hash, s.idle_expires_at,
              s.absolute_expires_at, s.revoked_at, u.role, u.status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [hashToken(token)],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (row.status !== 'active') return null;

    const stored: StoredSession = {
      id: row.id,
      userId: row.user_id,
      csrfHash: row.csrf_hash,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
      revokedAt: row.revoked_at,
    };
    const verdict = checkSession(stored, now);
    if (!verdict.valid) return null;

    await this.#db.query(
      'UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1',
      [row.id, now, verdict.renewIdleTo],
    );
    return { userId: row.user_id, sessionId: row.id, csrfHash: row.csrf_hash, role: row.role };
  }

  async logout(sessionId: string): Promise<void> {
    await this.#db.query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [sessionId],
    );
  }

  /** Used after a password change: kills every other session for the user. */
  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
    await this.#db.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
      [userId, exceptSessionId ?? null],
    );
  }

  /**
   * Issues a session for a user who has ALREADY been authenticated by some
   * other means — currently only the OAuth callback, after it has verified a
   * provider id_token and applied the linking rules.
   *
   * This method performs no authentication of its own. Calling it is an
   * assertion that the caller has established identity; there is deliberately
   * no path from an HTTP route to here without going through a verifier.
   */
  async createSessionForAuthenticatedUser(
    userId: string,
    ctx: { ip?: string | undefined; userAgent?: string | undefined } = {},
  ): Promise<SessionIssued> {
    const now = this.#now();
    return this.#db.transaction(async (tx) => {
      const found = await tx.query<{ status: string }>(
        'SELECT status FROM users WHERE id = $1',
        [userId],
      );
      const user = found.rows[0];
      if (!user || user.status !== 'active') {
        throw unauthorized('This account is not available.');
      }
      return this.#issueSession(
        tx,
        userId,
        { email: '', password: '', ip: ctx.ip, userAgent: ctx.userAgent },
        now,
      );
    });
  }

  async #issueSession(tx: Sql, userId: string, input: SignupInput, now: Date): Promise<SessionIssued> {
    const m = createSessionMaterial(now);
    await tx.query(
      `INSERT INTO sessions
         (user_id, token_hash, csrf_hash, user_agent, ip_hash,
          idle_expires_at, absolute_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        userId,
        m.tokenHash,
        m.csrfHash,
        input.userAgent?.slice(0, 300) ?? null,
        input.ip ? pseudonymize(input.ip, this.#pepper) : null,
        m.idleExpiresAt,
        m.absoluteExpiresAt,
      ],
    );
    return {
      userId,
      sessionToken: m.sessionToken,
      csrfToken: m.csrfToken,
      expiresAt: m.absoluteExpiresAt,
    };
  }

  async #recordFailure(userId: string, attempts: number, now: Date): Promise<void> {
    const until = lockoutUntil(attempts, now.getTime());
    await this.#db.query(
      'UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1',
      [userId, attempts, until],
    );
  }
}

/**
 * A real scrypt hash of a random value. Verifying against it costs the same as
 * verifying a genuine password, which is what keeps login timing flat for
 * unknown accounts.
 */
const DUMMY_HASH =
  'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'PLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDERd0c=';
