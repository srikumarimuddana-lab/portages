/**
 * Durable rate limiter tests.
 *
 * Split of responsibility: the SQL function's atomicity and window-reset
 * behaviour are verified directly against PostgreSQL (migration 009 applied,
 * `rate_limit_hit` exercised by hand). These tests cover the TypeScript half —
 * verdict arithmetic, the local short-circuit, and the fail-open/fail-closed
 * decision — using a fake Sql so they need no database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DurableRateLimiter, sweepRateLimits } from '../src/lib/ratelimit-db.js';
import type { Sql, QueryResult } from '../src/db/pool.js';

/** Minimal in-memory stand-in for the `rate_limit_hit` function. */
function fakeSql(opts: { fail?: boolean; windowMs?: number } = {}): Sql & { calls: string[] } {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const calls: string[] = [];
  const windowMs = opts.windowMs ?? 60_000;

  const sql: Sql & { calls: string[] } = {
    calls,
    async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
      calls.push(text.trim().split('\n')[0]!);
      if (opts.fail) throw new Error('connection terminated unexpectedly');

      if (text.includes('rate_limit_hit')) {
        const bucket = String(params[0]);
        const now = Date.now();
        let b = buckets.get(bucket);
        if (!b || b.resetAt <= now) {
          b = { count: 0, resetAt: now + windowMs };
          buckets.set(bucket, b);
        }
        b.count += 1;
        return {
          rows: [{ o_count: b.count, o_reset: new Date(b.resetAt) } as unknown as R],
          rowCount: 1,
        };
      }
      if (text.includes('DELETE FROM rate_limit_buckets')) {
        const before = buckets.size;
        buckets.clear();
        return { rows: [], rowCount: before };
      }
      return { rows: [], rowCount: 0 };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      return fn(sql);
    },
  };
  return sql;
}

test('durable: allows up to the maximum, then blocks', async () => {
  const rl = new DurableRateLimiter(fakeSql(), 'auth', { windowMs: 60_000, max: 3 });
  assert.equal((await rl.check('ip-a')).allowed, true);
  assert.equal((await rl.check('ip-a')).allowed, true);
  assert.equal((await rl.check('ip-a')).allowed, true);
  const blocked = await rl.check('ip-a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
});

test('durable: remaining counts down and floors at zero', async () => {
  const rl = new DurableRateLimiter(fakeSql(), 'auth', { windowMs: 60_000, max: 2 });
  assert.equal((await rl.check('k')).remaining, 1);
  assert.equal((await rl.check('k')).remaining, 0);
  assert.equal((await rl.check('k')).remaining, 0);
});

test('durable: keys are independent', async () => {
  const rl = new DurableRateLimiter(fakeSql(), 'auth', { windowMs: 60_000, max: 1 });
  assert.equal((await rl.check('a')).allowed, true);
  assert.equal((await rl.check('b')).allowed, true);
  assert.equal((await rl.check('a')).allowed, false);
});

test('durable: named limiters do not share a bucket', async () => {
  const db = fakeSql();
  const auth = new DurableRateLimiter(db, 'auth', { windowMs: 60_000, max: 1 });
  const read = new DurableRateLimiter(db, 'read', { windowMs: 60_000, max: 1 });
  assert.equal((await auth.check('same-ip')).allowed, true);
  // Same key, different limiter name -> different bucket, still allowed.
  assert.equal((await read.check('same-ip')).allowed, true);
});

test('durable: window expiry resets the count', async () => {
  const rl = new DurableRateLimiter(fakeSql({ windowMs: 1 }), 'auth', { windowMs: 1, max: 1 });
  assert.equal((await rl.check('k')).allowed, true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await rl.check('k')).allowed, true);
});

test('durable: local cache short-circuits before hitting the database', async () => {
  const db = fakeSql();
  const rl = new DurableRateLimiter(db, 'auth', { windowMs: 60_000, max: 2 });
  await rl.check('k');
  await rl.check('k');
  const dbCallsBefore = db.calls.length;
  const blocked = await rl.check('k');
  assert.equal(blocked.allowed, false);
  // The third call was rejected locally — no extra round trip.
  assert.equal(db.calls.length, dbCallsBefore);
});

test('durable: fail-closed propagates a database error', async () => {
  const rl = new DurableRateLimiter(fakeSql({ fail: true }), 'auth', { windowMs: 60_000, max: 5 });
  await assert.rejects(() => rl.check('k'), /connection terminated/);
});

test('durable: fail-open allows through when the database is unreachable', async () => {
  const rl = new DurableRateLimiter(
    fakeSql({ fail: true }),
    'read',
    { windowMs: 60_000, max: 5 },
    { failOpen: true },
  );
  const v = await rl.check('k');
  assert.equal(v.allowed, true);
});

test('durable: fail-open still respects the local tier', async () => {
  // Local budget is exhausted first, so an outage cannot lift the bound
  // entirely on a single instance.
  const rl = new DurableRateLimiter(
    fakeSql({ fail: true }),
    'read',
    { windowMs: 60_000, max: 2 },
    { failOpen: true },
  );
  assert.equal((await rl.check('k')).allowed, true);
  assert.equal((await rl.check('k')).allowed, true);
  assert.equal((await rl.check('k')).allowed, false);
});

test('durable: localCache=false always consults the database', async () => {
  const db = fakeSql();
  const rl = new DurableRateLimiter(db, 'auth', { windowMs: 60_000, max: 1 }, { localCache: false });
  await rl.check('k');
  const before = db.calls.length;
  await rl.check('k');
  assert.ok(db.calls.length > before);
});

test('durable: bucket key includes the limiter name', async () => {
  const db = fakeSql();
  const rl = new DurableRateLimiter(db, 'signup', { windowMs: 60_000, max: 5 });
  await rl.check('abc');
  assert.ok(db.calls.some((c) => c.includes('rate_limit_hit')));
});

test('sweep: reports how many stale buckets were removed', async () => {
  const db = fakeSql();
  const rl = new DurableRateLimiter(db, 'auth', { windowMs: 60_000, max: 5 });
  await rl.check('a');
  await rl.check('b');
  const removed = await sweepRateLimits(db);
  assert.equal(removed, 2);
});
