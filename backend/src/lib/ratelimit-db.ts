/**
 * Durable, shared rate limiting.
 *
 * Why this exists: `RateLimiter` in ./ratelimit.ts keeps counters in process
 * memory. That is correct for one process and WRONG on Vercel, where many warm
 * instances serve concurrently and each keeps its own counters — the effective
 * limit becomes (max x instances), and an attacker spreading requests across
 * instances bypasses login throttling entirely.
 *
 * State is therefore shared in Postgres, incremented by the `rate_limit_hit`
 * function (migration 009) which does the check in a single atomic upsert.
 *
 * The two-tier arrangement below is deliberate: an in-process cache absorbs
 * the obvious repeat offender without a round trip, while Postgres remains the
 * source of truth. A caller that is already over the limit locally is rejected
 * immediately; everyone else is counted centrally.
 */
import type { RateLimitRule, RateLimitVerdict } from './ratelimit.js';
import { RateLimiter } from './ratelimit.js';
import type { Sql } from '../db/pool.js';

/**
 * Both limiter implementations satisfy this. The union return type lets the
 * synchronous in-memory limiter be used interchangeably with the async
 * durable one — callers simply `await`.
 */
export interface Limiter {
  check(key: string, now?: number): RateLimitVerdict | Promise<RateLimitVerdict>;
}

export interface DurableLimiterOptions {
  /** Also keep a local cache to short-circuit obvious repeat offenders. */
  localCache?: boolean;
  /**
   * What to do when the database is unreachable. Rate limiting is a
   * protection, not a feature: failing open keeps the site usable during a
   * database blip, failing closed protects a login endpoint from an outage
   * being used as a throttle bypass. Default is per-call.
   */
  failOpen?: boolean;
}

export class DurableRateLimiter implements Limiter {
  readonly #db: Sql;
  readonly #rule: RateLimitRule;
  readonly #name: string;
  readonly #local: RateLimiter | null;
  readonly #failOpen: boolean;

  constructor(db: Sql, name: string, rule: RateLimitRule, opts: DurableLimiterOptions = {}) {
    this.#db = db;
    this.#name = name;
    this.#rule = rule;
    this.#failOpen = opts.failOpen ?? false;
    // The local tier is given the same budget; it can only ever reject
    // earlier than the shared tier, never permit more.
    this.#local = opts.localCache === false ? null : new RateLimiter(rule);
  }

  async check(key: string): Promise<RateLimitVerdict> {
    const bucket = `${this.#name}:${key}`;

    // L1: if this instance alone has already seen too many, stop here.
    if (this.#local) {
      const localVerdict = this.#local.check(key);
      if (!localVerdict.allowed) return localVerdict;
    }

    try {
      const { rows } = await this.#db.query<{ o_count: number; o_reset: Date }>(
        'SELECT o_count, o_reset FROM rate_limit_hit($1, $2::interval)',
        [bucket, `${this.#rule.windowMs} milliseconds`],
      );
      const row = rows[0];
      if (!row) throw new Error('rate_limit_hit returned no row');

      const resetAt = new Date(row.o_reset).getTime();
      const allowed = row.o_count <= this.#rule.max;
      return {
        allowed,
        remaining: Math.max(0, this.#rule.max - row.o_count),
        resetAt,
        retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
      };
    } catch (err) {
      if (this.#failOpen) {
        // Deliberate: a database outage should not take the whole site down
        // for read paths. The local tier is still applying a bound.
        return { allowed: true, remaining: 0, resetAt: Date.now() + this.#rule.windowMs, retryAfterSec: 0 };
      }
      throw err;
    }
  }
}

/**
 * Deletes expired buckets. Called by the scheduled job runner; the hot path
 * resets windows in place, so this only reclaims rows for keys that stopped
 * being used entirely.
 */
export async function sweepRateLimits(db: Sql, limit = 10_000): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM rate_limit_buckets
      WHERE bucket IN (
        SELECT bucket FROM rate_limit_buckets
         WHERE reset_at < now() - interval '1 hour'
         LIMIT $1
      )`,
    [limit],
  );
  return rowCount;
}
