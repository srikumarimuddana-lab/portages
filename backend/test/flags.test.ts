/**
 * Kill switch tests.
 *
 * The thing under test is not really "does a boolean round-trip". It is the
 * three-state cache, because the obvious two-state version is wrong in the
 * expensive direction: a two-second database blip would turn email off
 * site-wide, and a safety mechanism that causes the outage it was built to
 * prevent is worse than not having it.
 *
 * So the clock is injected everywhere and the fake Sql can be told to start
 * failing mid-test. Every assertion about FRESH / STALE / BLIND is an
 * assertion about which of those a real operator would be relying on.
 *
 * The database half — the CHECK on rollout_pct, the audit row landing in the
 * same transaction, the row surviving a staff account deletion — is asserted
 * against real PostgreSQL in test/sql/flags.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FlagService, bucketOf, TTL_MS, GRACE_MS, RETRY_MS,
} from '../src/modules/flags/service.js';
import {
  FLAGS, FLAG_KEYS, defaultStateOf, isFlagKey,
} from '../src/modules/flags/registry.js';
import { ALLOW_ALL, NotifyService } from '../src/modules/notify/service.js';
import { AppError } from '../src/lib/errors.js';
import type { Sql, QueryResult } from '../src/db/pool.js';

const ADMIN = { userId: '99999999-9999-4999-8999-999999999999', role: 'admin' as const };

interface Stmt { text: string; params: readonly unknown[]; on: string }

/**
 * A fake Sql with a clock and a failure switch.
 *
 * `rows` is mutable so a test can change what the store holds and then prove
 * the change is *not* visible until the TTL expires — which is the whole
 * contract of the cache.
 */
function flagDb(rows: Record<string, unknown>[] = []) {
  const statements: Stmt[] = [];
  const state = { rows, fail: false, queries: 0 };

  const handle = (on: string): Sql => ({
    async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
      const t = text.replace(/\s+/g, ' ').trim();
      statements.push({ text: t, params, on });
      if (state.fail) throw new Error('flag store unreachable');
      if (t.includes('FROM feature_flags')) {
        state.queries++;
        const match = params.length
          ? state.rows.filter((r) => r['key'] === params[0])
          : state.rows;
        return { rows: match as R[], rowCount: match.length };
      }
      if (t.startsWith('INSERT INTO feature_flags')) {
        return { rows: [rowFor(params) as R], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> { return fn(handle('tx')); },
  });

  return Object.assign(handle('db'), { statements, state });
}

function rowFor(params: readonly unknown[]): Record<string, unknown> {
  return {
    key: params[0],
    enabled: params[1] ?? true,
    rollout_pct: params[2] ?? 100,
    note: params[3] ?? null,
    updated_by: params[4] ?? null,
    updated_at: new Date('2026-08-31T12:00:00Z'),
  };
}

const row = (key: string, over: Record<string, unknown> = {}) => ({
  key, enabled: true, rollout_pct: 100, note: null,
  updated_by: null, updated_at: new Date('2026-08-31T12:00:00Z'), ...over,
});

/** A service with a clock the test drives by hand. */
function svc(rows: Record<string, unknown>[] = [], audit?: { record: (tx: Sql, e: unknown) => Promise<void> }) {
  const db = flagDb(rows);
  let t = 1_000_000;
  const service = new FlagService(db, {
    now: () => t,
    ...(audit ? { audit } : {}),
  });
  return { db, service, advance: (ms: number) => { t += ms; }, at: () => t };
}

// ── the registry ────────────────────────────────────────────────────────────

test('registry: keys are namespaced and unique', () => {
  assert.equal(new Set(FLAG_KEYS).size, FLAG_KEYS.length);
  for (const key of FLAG_KEYS) {
    assert.match(key, /^[a-z]+\.[a-z_]+$/, `${key} must be group.name`);
  }
});

test('registry: every flag says what breaks when it is off', () => {
  // The switch is thrown by someone under pressure who did not write it. A
  // key with no stated effect is a switch nobody dares touch.
  for (const key of FLAG_KEYS) {
    assert.ok(FLAGS[key].effect.length > 20, `${key} needs a real effect description`);
    assert.ok(FLAGS[key].label.length > 0);
  }
});

test('registry: money and mail fail CLOSED, the product fails OPEN', () => {
  // The asymmetry is the safety argument, so it is asserted rather than left
  // to a comment that can drift from the values below it.
  for (const key of ['channel.email', 'channel.sms', 'channel.whatsapp',
                     'ai.chat_search', 'ai.listing_builder', 'ai.moderation'] as const) {
    assert.equal(FLAGS[key].failsafe, false, `${key} must fail closed — it spends money or sends mail`);
  }
  for (const key of ['signups.new', 'listings.new', 'uploads.new',
                     'oauth.google', 'oauth.facebook'] as const) {
    assert.equal(FLAGS[key].failsafe, true, `${key} must fail open — a database blip must not close the product`);
  }
});

test('registry: an unseeded kill switch defaults ON, which is not its failsafe', () => {
  // The trap this guards: conflating "nobody has written a row" with "the
  // database is unreadable". Treating an empty table as the fail-safe would
  // take email down on a fresh install.
  assert.deepEqual(defaultStateOf('channel.email'), { enabled: true, rolloutPct: 100 });
  assert.equal(FLAGS['channel.email'].failsafe, false);
});

test('registry: isFlagKey rejects anything not declared', () => {
  assert.ok(isFlagKey('channel.email'));
  assert.ok(!isFlagKey('chanel.email'));
  assert.ok(!isFlagKey('__proto__'));
  assert.ok(!isFlagKey('toString'));
});

// ── reading ─────────────────────────────────────────────────────────────────

test('a flag with no row uses its default', async () => {
  const { service } = svc([]);
  assert.equal(await service.isEnabled('channel.email'), true);
});

test('a thrown switch is off', async () => {
  const { service } = svc([row('channel.email', { enabled: false })]);
  assert.equal(await service.isEnabled('channel.email'), false);
});

test('the whole table is read once, not once per key', async () => {
  const { db, service } = svc([row('channel.email')]);
  for (const key of FLAG_KEYS) await service.isEnabled(key);
  assert.equal(db.state.queries, 1, 'a query per call site is what the cache exists to avoid');
});

// ── the three cache states ──────────────────────────────────────────────────

test('cache: within the TTL a change in the store is not yet visible', async () => {
  const { db, service, advance } = svc([row('channel.email')]);
  assert.equal(await service.isEnabled('channel.email'), true);
  assert.equal(await service.cacheState(), 'fresh');

  db.state.rows = [row('channel.email', { enabled: false })];
  advance(TTL_MS - 1);
  assert.equal(await service.isEnabled('channel.email'), true, 'still serving the snapshot');
  assert.equal(db.state.queries, 1);
});

test('cache: past the TTL the change lands', async () => {
  const { db, service, advance } = svc([row('channel.email')]);
  await service.isEnabled('channel.email');

  db.state.rows = [row('channel.email', { enabled: false })];
  advance(TTL_MS + 1);
  assert.equal(await service.isEnabled('channel.email'), false);
  assert.equal(db.state.queries, 2);
});

test('cache: the TTL leaves room for a missed refresh inside the 30s budget', () => {
  // The gate in analysis/11 is "under 30 seconds without a deploy". Two full
  // cycles must fit, so one failed refresh does not blow the budget.
  assert.ok(TTL_MS * 2 < 30_000, 'two refresh cycles must fit in the 30s budget');
});

test('cache: STALE — a brief outage keeps serving the last known values', async () => {
  // The whole reason for three states. Failing to the fail-safe here would
  // turn email off site-wide because the database hiccuped for two seconds.
  const { db, service, advance } = svc([row('channel.email')]);
  assert.equal(await service.isEnabled('channel.email'), true);

  db.state.fail = true;
  advance(TTL_MS + 1);
  assert.equal(await service.isEnabled('channel.email'), true, 'a 10s-old snapshot is knowledge, not ignorance');
  assert.equal(await service.cacheState(), 'stale');
});

test('cache: BLIND — past the grace window it falls to the fail-safe', async () => {
  const { db, service, advance } = svc([row('channel.email'), row('signups.new')]);
  await service.isEnabled('channel.email');

  db.state.fail = true;
  advance(GRACE_MS + 1);

  assert.equal(await service.isEnabled('channel.email'), false, 'mail fails closed');
  assert.equal(await service.isEnabled('signups.new'), true, 'the product fails open');
  assert.equal(await service.cacheState(), 'blind');
});

test('cache: BLIND from the very first call, with no snapshot at all', async () => {
  // Boot during an outage. There is nothing stale to fall back to.
  const { db, service } = svc([]);
  db.state.fail = true;
  assert.equal(await service.isEnabled('channel.email'), false);
  assert.equal(await service.isEnabled('listings.new'), true);
});

test('cache: a failing store is not queried on every request', async () => {
  const { db, service, advance } = svc([row('channel.email')]);
  await service.isEnabled('channel.email');
  advance(TTL_MS + 1);

  db.state.fail = true;
  const before = db.statements.length;
  for (let i = 0; i < 20; i++) await service.isEnabled('channel.email');
  const attempts = db.statements.length - before;
  assert.ok(attempts <= 2, `backs off after a failure; made ${attempts} attempts`);

  // ...and tries again once the retry window passes.
  advance(RETRY_MS + 1);
  await service.isEnabled('channel.email');
  assert.ok(db.statements.length > before + attempts, 'it must not give up permanently');
});

test('cache: recovery returns to fresh', async () => {
  const { db, service, advance } = svc([row('channel.email', { enabled: false })]);
  await service.isEnabled('channel.email');

  db.state.fail = true;
  advance(TTL_MS + 1);
  assert.equal(await service.cacheState(), 'stale');

  db.state.fail = false;
  advance(RETRY_MS + 1);
  assert.equal(await service.isEnabled('channel.email'), false);
  assert.equal(await service.cacheState(), 'fresh');
});

test('cache: a burst at TTL expiry issues one query, not fifty', async () => {
  const { db, service, advance } = svc([row('channel.email')]);
  await service.isEnabled('channel.email');
  advance(TTL_MS + 1);

  const before = db.state.queries;
  await Promise.all(Array.from({ length: 50 }, () => service.isEnabled('channel.email')));
  assert.equal(db.state.queries - before, 1, 'concurrent refreshes must share one in-flight read');
});

// ── channels ────────────────────────────────────────────────────────────────

test('channel: the KillSwitch interface NotifyService has held open is satisfied', async () => {
  const { service } = svc([row('channel.email', { enabled: false })]);
  assert.equal(await service.isChannelEnabled('email'), false);
  assert.equal(await service.isChannelEnabled('sms'), true);

  // The default it replaces said yes to everything, which is what made the
  // seam invisible until now.
  assert.equal(await ALLOW_ALL.isChannelEnabled('email'), true);
});

test('channel: a channel with no flag declared is refused, not allowed', async () => {
  // Registry and notify module drifting apart must not silently enable a
  // channel nobody decided was allowed.
  const { service } = svc([]);
  assert.equal(await service.isChannelEnabled('push' as never), false);
});

// ── rollout buckets ─────────────────────────────────────────────────────────

test('rollout: a user gets the same answer every time', async () => {
  const { service } = svc([row('ai.chat_search', { rollout_pct: 50 })]);
  const first = await service.isEnabled('ai.chat_search', 'user-1');
  for (let i = 0; i < 20; i++) {
    assert.equal(await service.isEnabled('ai.chat_search', 'user-1'), first,
      'a feature that flickers between page loads is worse than one that is off');
  }
});

test('rollout: buckets are spread, and differ per flag', async () => {
  const users = Array.from({ length: 2000 }, (_, i) => `user-${i}`);
  const inA = users.filter((u) => bucketOf('ai.chat_search', u) < 10).length;
  assert.ok(inA > 130 && inA < 270, `10% of 2000 should be near 200, got ${inA}`);

  // Two features at 10% must not hit the identical tenth of users, or the
  // same unlucky people are the guinea pigs for everything.
  const a = new Set(users.filter((u) => bucketOf('ai.chat_search', u) < 10));
  const b = new Set(users.filter((u) => bucketOf('ai.listing_builder', u) < 10));
  const overlap = [...a].filter((u) => b.has(u)).length;
  assert.ok(overlap < a.size * 0.5, `buckets must be independent; overlap was ${overlap}/${a.size}`);
});

test('rollout: 0 and 100 short-circuit without needing a subject', async () => {
  const off = svc([row('ai.chat_search', { rollout_pct: 0 })]);
  assert.equal(await off.service.isEnabled('ai.chat_search', 'user-1'), false);

  const on = svc([row('ai.chat_search', { rollout_pct: 100 })]);
  assert.equal(await on.service.isEnabled('ai.chat_search'), true);
});

test('rollout: a partial rollout with no subject is off, not on', async () => {
  // Anonymous traffic cannot be bucketed. Treating that as "in" would ship
  // the feature to every logged-out visitor at once — the opposite of staged.
  const { service } = svc([row('ai.chat_search', { rollout_pct: 50 })]);
  assert.equal(await service.isEnabled('ai.chat_search'), false);
  assert.equal(await service.isEnabled('ai.chat_search', null), false);
});

test('rollout: disabled beats any percentage', async () => {
  const { service } = svc([row('ai.chat_search', { enabled: false, rollout_pct: 100 })]);
  assert.equal(await service.isEnabled('ai.chat_search', 'user-1'), false);
});

// ── writing ─────────────────────────────────────────────────────────────────

test('set: writes the flag and its audit entry in one transaction', async () => {
  const recorded: Array<{ tx: Sql; entry: Record<string, unknown> }> = [];
  const { db, service } = svc([row('channel.email')], {
    async record(tx, e) { recorded.push({ tx, entry: e as never }); },
  });

  await service.set('channel.email', { enabled: false, note: 'SES bounce spike' }, { ...ADMIN, ip: '198.51.100.7' });

  const insert = db.statements.find((s) => s.text.startsWith('INSERT INTO feature_flags'))!;
  assert.equal(insert.on, 'tx');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.entry['action'], 'flag.set');
  assert.equal(recorded[0]!.entry['subject'], 'flag');
  assert.equal(recorded[0]!.entry['subjectId'], 'channel.email');
  assert.deepEqual(recorded[0]!.entry['before'], { enabled: true, rolloutPct: 100 });
  assert.deepEqual(recorded[0]!.entry['after'], { enabled: false, rolloutPct: 100, note: 'SES bounce spike' });
  assert.equal(recorded[0]!.entry['ip'], '198.51.100.7');
});

test('set: the admin who flipped it sees the new value at once', async () => {
  // Waiting out the TTL after clicking reads as a button that did not work,
  // and the next thing that happens is someone clicking it four more times.
  const { db, service } = svc([row('channel.email')]);
  assert.equal(await service.isEnabled('channel.email'), true);

  db.state.rows = [row('channel.email', { enabled: false })];
  await service.set('channel.email', { enabled: false }, ADMIN);

  assert.equal(await service.isEnabled('channel.email'), false, 'no TTL wait for the process that wrote it');
});

test('set: an unknown key is 404, and is not echoed back', async () => {
  const { service } = svc([]);
  await assert.rejects(
    () => service.set('chanel.email', { enabled: false }, ADMIN),
    (err: AppError) => err.status === 404 && !err.message.includes('chanel'),
  );
});

test('set: a kill switch has no partial rollout', async () => {
  // "Email is 40% off" is not an incident response, it is a confusing outage.
  const { service } = svc([]);
  await assert.rejects(
    () => service.set('channel.email', { rolloutPct: 40 }, ADMIN),
    (err: AppError) => err.status === 400,
  );
  // 100 is a no-op and allowed, so an UI that always sends both fields works.
  await service.set('channel.email', { enabled: false, rolloutPct: 100 }, ADMIN);
});

test('set: out-of-range and non-integer rollouts are refused', async () => {
  const { service } = svc([]);
  for (const pct of [-1, 101, 12.5, NaN]) {
    await assert.rejects(
      () => service.set('ai.chat_search', { rolloutPct: pct }, ADMIN),
      (err: AppError) => err.status === 400,
      `rolloutPct ${pct} must be refused`,
    );
  }
});

test('list: every declared flag appears, written or not', async () => {
  // A console showing only written rows is one where the switch you need at
  // 3am is the one that is not on the screen.
  const { service } = svc([row('channel.email', { enabled: false, note: 'bounce spike' })]);
  const all = await service.list();

  assert.equal(all.length, FLAG_KEYS.length);
  const email = all.find((f) => f.key === 'channel.email')!;
  assert.equal(email.enabled, false);
  assert.equal(email.configured, true);
  assert.equal(email.note, 'bounce spike');

  const untouched = all.find((f) => f.key === 'ai.moderation')!;
  assert.equal(untouched.configured, false, 'never written');
  assert.equal(untouched.enabled, true, 'and therefore at its default');
  assert.equal(untouched.failsafe, false, 'while still reporting what happens when we are blind');
});

test('set: a partial patch on an UNWRITTEN flag supplies the registry default', async () => {
  // The bug this exists for: `enabled` and `rollout_pct` are NOT NULL, so
  // passing NULL for the field the patch omitted made the very first flip of
  // any flag fail on the INSERT — `{"enabled": false}` on a fresh install,
  // which is the first thing anyone ever does with a kill switch.
  //
  // The fake Sql does not enforce NOT NULL, so it reported success;
  // test/sql/flags.sql caught it against real PostgreSQL. This asserts the
  // shape here too, so the unit suite is no longer blind to it.
  const { db, service } = svc([]);
  await service.set('channel.email', { enabled: false }, ADMIN);

  const insert = db.statements.find((s) => s.text.startsWith('INSERT INTO feature_flags'))!;
  assert.ok(
    insert.text.includes('COALESCE($2, $6)') && insert.text.includes('COALESCE($3, $7)'),
    'the INSERT branch must fall back to a default, not to NULL',
  );
  assert.equal(insert.params[2], null, 'the patch did not mention rolloutPct');
  assert.equal(insert.params[6], 100, 'so the registry default is supplied for the new row');
  assert.equal(insert.params[5], true, 'and for enabled, which the ON CONFLICT branch then overrides');
});

test('every flag declared today is a kill switch, so no partial rollout can be created', async () => {
  // Worth stating rather than leaving implicit: the rollout tier is
  // implemented (bucketOf, rollout_pct, the percentage branch in isEnabled)
  // and NOTHING USES IT YET, because every capability that exists today is
  // either on or off — there is nothing staged to roll out.
  //
  // So `set()` refuses a partial rollout on all of them, which this asserts
  // across the whole registry rather than for one key. When the first rollout
  // flag lands, the tier field is what makes it legal, and the bucketing
  // tests above already cover the arithmetic.
  for (const key of FLAG_KEYS) {
    assert.equal(FLAGS[key].tier, 'kill_switch', `${key}: update this test when a rollout flag lands`);
    const { service } = svc([]);
    await assert.rejects(
      () => service.set(key, { rolloutPct: 25 }, ADMIN),
      (err: AppError) => err.status === 400,
      `${key} is a kill switch and must refuse a partial rollout`,
    );
  }
});

test('set: changing a switch clears the old note rather than keeping a stale reason', async () => {
  // "SES bounce spike" left sitting on a flag that is back on is worse than
  // no note: it reads as a live incident. The history is in the audit log.
  const { db, service } = svc([row('channel.email', { enabled: false, note: 'SES bounce spike' })]);
  await service.set('channel.email', { enabled: true }, ADMIN);
  const insert = db.statements.find((s) => s.text.startsWith('INSERT INTO feature_flags'))!;
  assert.equal(insert.params[3], null);
});

// ── the gate: a thrown switch provably stops a send ─────────────────────────

test('gate: a thrown flag row stops a real send, with no provider call', async () => {
  // notify.test.ts already proves a hand-written KillSwitch stub blocks a
  // send. This proves the WIRING: a row in feature_flags, read by the real
  // FlagService, injected where app.ts injects it, reaching the provider
  // never. That composition is what the gate in analysis/11 asks for and it
  // is the part a stub cannot demonstrate.
  const providerCalls: string[] = [];
  const deliveries: Array<Record<string, unknown>> = [];

  const db: Sql = {
    async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.includes('FROM feature_flags')) {
        return { rows: [row('channel.email', { enabled: false }) as R], rowCount: 1 };
      }
      if (t.startsWith('INSERT INTO notification_deliveries')) {
        return { rows: [{ id: 'd-1' } as R], rowCount: 1 };
      }
      // The outcome is stamped by the UPDATE, not the INSERT: the row is
      // claimed first, then finished with its verdict.
      if (t.startsWith('UPDATE notification_deliveries')) {
        deliveries.push({ id: params[0], status: params[1], error: params[3] });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> { return fn(db); },
  };

  const flags = new FlagService(db);
  const notify = new NotifyService(
    db,
    [{
      kind: 'email' as const,
      isConfigured: () => true,
      async send() { providerCalls.push('sent'); return { providerMessageId: 'm-1' }; },
    } as never],
    { killSwitch: flags },
  );

  const result = await notify.send({
    to: 'someone@example.test', channel: 'email', template: 'otp_email',
    vars: { code: '123456', minutes: 5 }, category: 'transactional',
    idempotencyKey: 'gate-1',
  });

  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') assert.equal(result.reason, 'channel_disabled');
  assert.equal(providerCalls.length, 0, 'the provider must never be reached');

  // And it is recorded, so "why did no email go out last night" is answerable
  // afterwards rather than being an invisible silence.
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!['status'], 'blocked');
  assert.match(String(deliveries[0]!['error']), /kill switch/i, 'and says why');
});

test('gate: releasing the switch lets the same send through', async () => {
  // The other half. A kill switch that cannot be released is a deploy.
  const providerCalls: string[] = [];
  const flagRow = { current: row('channel.email', { enabled: false }) };

  const db: Sql = {
    async query<R>(text: string): Promise<QueryResult<R>> {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.includes('FROM feature_flags')) return { rows: [flagRow.current as R], rowCount: 1 };
      if (t.startsWith('INSERT INTO notification_deliveries')) {
        return { rows: [{ id: 'd-1' } as R], rowCount: 1 };
      }
      if (t.includes('FROM notification_suppressions')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> { return fn(db); },
  };

  let clock = 1_000_000;
  const flags = new FlagService(db, { now: () => clock });
  const notify = new NotifyService(
    db,
    [{
      kind: 'email' as const,
      isConfigured: () => true,
      async send() { providerCalls.push('sent'); return { providerMessageId: 'm-1' }; },
    } as never],
    { killSwitch: flags },
  );

  const send = (key: string) => notify.send({
    to: 'someone@example.test', channel: 'email', template: 'otp_email',
    vars: { code: '123456', minutes: 5 }, category: 'transactional', idempotencyKey: key,
  });

  assert.equal((await send('g-1')).status, 'blocked');

  flagRow.current = row('channel.email', { enabled: true });
  clock += TTL_MS + 1;   // one TTL, well inside the 30s budget the gate sets

  assert.notEqual((await send('g-2')).status, 'blocked');
  assert.equal(providerCalls.length, 1, 'the release must actually reach the provider');
});
