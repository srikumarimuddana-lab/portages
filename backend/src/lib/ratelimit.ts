/**
 * Rate limiting and credential-stuffing defence.
 *
 * The in-memory limiter below is correct for a single process. Behind more
 * than one instance, back it with Redis or a Postgres table — the interface is
 * the same, which is why the algorithm lives here rather than inline.
 */

export interface RateLimitRule {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests permitted per key inside the window. */
  max: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
  /** Seconds a client should wait; only meaningful when blocked. */
  retryAfterSec: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #rule: RateLimitRule;
  readonly #maxKeys: number;

  constructor(rule: RateLimitRule, maxKeys = 100_000) {
    this.#rule = rule;
    this.#maxKeys = maxKeys;
  }

  check(key: string, now = Date.now()): RateLimitVerdict {
    this.#sweep(now);
    let b = this.#buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + this.#rule.windowMs };
      // Bound memory: an attacker rotating keys must not exhaust the heap.
      if (this.#buckets.size >= this.#maxKeys) this.#evictOldest();
      this.#buckets.set(key, b);
    }
    b.count += 1;
    const allowed = b.count <= this.#rule.max;
    return {
      allowed,
      remaining: Math.max(0, this.#rule.max - b.count),
      resetAt: b.resetAt,
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    };
  }

  reset(key: string): void {
    this.#buckets.delete(key);
  }

  #sweep(now: number): void {
    if (this.#buckets.size < 1000) return;
    for (const [k, v] of this.#buckets) {
      if (now >= v.resetAt) this.#buckets.delete(k);
    }
  }

  #evictOldest(): void {
    const first = this.#buckets.keys().next();
    if (!first.done) this.#buckets.delete(first.value);
  }
}

/**
 * Exponential lockout for repeated failed logins on one account.
 * Returns the lockout expiry, or null while the account is still open.
 *
 * Deliberately account-scoped rather than IP-scoped: distributed credential
 * stuffing rotates IPs, so an IP-only limit is close to useless against it.
 * IP limits still apply on top, via RateLimiter.
 */
export function lockoutUntil(failedAttempts: number, now = Date.now()): Date | null {
  if (failedAttempts < 5) return null;
  const over = failedAttempts - 5;
  const delayMs = Math.min(60_000 * 2 ** over, 60 * 60 * 1000); // 1 min → 1 hour
  return new Date(now + delayMs);
}

export function isLocked(lockedUntil: Date | null | undefined, now = new Date()): boolean {
  return !!lockedUntil && lockedUntil > now;
}

/** Standard limits. Auth is deliberately far stricter than browsing. */
export const LIMITS = {
  login: { windowMs: 15 * 60_000, max: 10 },
  signup: { windowMs: 60 * 60_000, max: 5 },
  passwordReset: { windowMs: 60 * 60_000, max: 5 },
  write: { windowMs: 60_000, max: 60 },
  read: { windowMs: 60_000, max: 300 },
  upload: { windowMs: 60 * 60_000, max: 100 },
} as const satisfies Record<string, RateLimitRule>;
