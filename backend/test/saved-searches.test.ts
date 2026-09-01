/**
 * Saved searches, and the consent that governs their alerts.
 *
 * Most of these are about CASL rather than about search. An alert is a
 * commercial electronic message: it needs express consent the sender can
 * prove, withdrawal has to be honoured with no grace period, and the penalty
 * for getting it wrong is larger than this business. So the assertions are
 * written as "what would have to be true for an unlawful message to be sent",
 * and each one closes a way it could happen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SavedSearchService, MAX_SAVED_SEARCHES, INTERVAL_HOURS } from '../src/modules/search/saved.js';
import { SearchService } from '../src/modules/search/service.js';

const USER = 'user-1';

/** Records what was asked of the database and the consent service. */
function harness(over: {
  rows?: Record<string, unknown[]>;
  count?: number;
  grantThrows?: boolean;
} = {}) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const consent = { granted: [] as unknown[], revoked: [] as unknown[] };

  const db = {
    async query(text: string, p?: readonly unknown[]) {
      sql.push(text);
      params.push([...(p ?? [])]);
      if (text.includes('count(*)')) {
        return { rows: [{ n: String(over.count ?? 0) }], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO saved_searches')) {
        return { rows: [{ id: 'saved-1' }], rowCount: 1 };
      }
      for (const [needle, rows] of Object.entries(over.rows ?? {})) {
        if (text.includes(needle)) return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 1 };
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> { return fn(db); },
  } as never;

  const consentService = {
    async grant(input: unknown) {
      if (over.grantThrows) throw new Error('consent store unavailable');
      consent.granted.push(input);
      return 'consent-1';
    },
    async revoke(userId: string, kind: string, channel: string) {
      consent.revoked.push({ userId, kind, channel });
    },
  } as never;

  const svc = new SavedSearchService({
    db,
    search: new SearchService({} as never),
    consent: consentService,
    now: () => new Date('2026-09-01T12:00:00Z'),
  });
  return { svc, sql, params, consent };
}

// ── saving ──────────────────────────────────────────────────────────────────

test('a saved search is validated before it is stored, not when it runs', async () => {
  // The difference between a saved search and a stored blob of JSON. A spec
  // that would be rejected today must not be accepted now and then fail every
  // night for a year inside a job nobody is watching.
  const { svc } = harness();
  await assert.rejects(
    () => svc.save({ userId: USER, name: 'Bad', spec: { minBeds: 'lots' } }),
    (err: { status?: number }) => err.status === 400,
  );
});

test('the stored spec drops the cursor', async () => {
  // A standing query re-run every night is not "page two of a result set from
  // last Tuesday".
  const { svc, params } = harness();
  await svc.save({
    userId: USER, name: 'Two beds',
    spec: { minBeds: 2, cursor: 'abc', sort: 'newest' },
  });
  const insert = params.find((p) => typeof p[2] === 'string' && p[2].startsWith('{'));
  const stored = JSON.parse(insert![2] as string);
  assert.equal(stored.minBeds, 2);
  assert.ok(!('cursor' in stored), 'a cursor must not be stored');
});

test('saving does not turn alerts on', async () => {
  // Consent asked for in passing, bundled into another action, is the weakest
  // kind there is. Saving a search is not consent to be emailed.
  const { svc, consent, params } = harness();
  await svc.save({ userId: USER, name: 'Two beds', spec: { minBeds: 2 } });
  assert.deepEqual(consent.granted, [], 'no consent may be recorded by saving');
  const insert = params.find((p) => p.length === 6)!;
  assert.equal(insert[4], false, 'alert_enabled must be false');
  assert.equal(insert[5], null, 'and no consent id');
});

test('the per-user cap is enforced before anything is written', async () => {
  const { svc, sql } = harness({ count: MAX_SAVED_SEARCHES });
  await assert.rejects(
    () => svc.save({ userId: USER, name: 'One more', spec: {} }),
    (err: { status?: number }) => err.status === 400,
  );
  assert.ok(!sql.some((q) => q.startsWith('INSERT INTO saved_searches')));
});

// ── consent ─────────────────────────────────────────────────────────────────

test('enabling an alert records consent BEFORE the row that depends on it', async () => {
  // `alert_requires_consent` refuses a row with alert_enabled and no
  // consent_id. Granting first means the forbidden state is never written even
  // momentarily, and a consent store that is down is a failure to enable
  // rather than an alert that quietly cannot send.
  const { svc, sql, consent, params } = harness({
    rows: { 'SELECT name, alert_enabled': [{ name: 'Two beds', alert_enabled: false }] },
  });
  await svc.setAlert('saved-1', USER, { enabled: true });

  assert.equal(consent.granted.length, 1);
  const update = params.find((p) => p[2] === 'consent-1');
  assert.ok(update, 'the consent id must be stored on the row');
  assert.ok(sql.some((q) => q.includes('alert_enabled = true')));
});

test('a consent failure is a failure to enable, not a half-enabled alert', async () => {
  const { svc, sql } = harness({
    rows: { 'SELECT name, alert_enabled': [{ name: 'Two beds', alert_enabled: false }] },
    grantThrows: true,
  });
  await assert.rejects(() => svc.setAlert('saved-1', USER, { enabled: true }));
  assert.ok(
    !sql.some((q) => q.includes('alert_enabled = true')),
    'nothing may be marked enabled when consent was not recorded',
  );
});

test('turning an alert off revokes the consent, not just the flag', async () => {
  // This is what an unsubscribe has to produce. Leaving the consent row live
  // and only flipping a boolean means the evidence trail says the person
  // still wants these — which is the record that would be produced in a
  // complaint.
  const { svc, consent, sql } = harness({
    rows: { 'SELECT name, alert_enabled': [{ name: 'Two beds', alert_enabled: true }] },
  });
  await svc.setAlert('saved-1', USER, { enabled: false });

  assert.deepEqual(consent.revoked, [
    { userId: USER, kind: 'saved_search_alert', channel: 'email' },
  ]);
  assert.ok(sql.some((q) => q.includes('alert_enabled = false')));
  assert.ok(sql.some((q) => q.includes('consent_id = NULL')), 'and the id is cleared');
});

test('deleting a search with alerts on revokes its consent too', async () => {
  // Otherwise the trail claims consent for a search that no longer exists.
  const { svc, consent } = harness({
    rows: { 'DELETE FROM saved_searches': [{ alert_enabled: true }] },
  });
  await svc.remove('saved-1', USER);
  assert.equal(consent.revoked.length, 1);
});

test('deleting a search without alerts revokes nothing', async () => {
  // The person may have another saved search still alerting. Revoking here
  // would silently switch that one off.
  const { svc, consent } = harness({
    rows: { 'DELETE FROM saved_searches': [{ alert_enabled: false }] },
  });
  await svc.remove('saved-1', USER);
  assert.deepEqual(consent.revoked, []);
});

test('consent evidence records what happened, not that it happened', async () => {
  // CASL puts the burden of proving consent on the sender. "The user
  // consented" is not evidence; what they did, where, and when is.
  const { svc, consent } = harness({
    rows: { 'SELECT name, alert_enabled': [{ name: 'Two beds', alert_enabled: false }] },
  });
  await svc.setAlert('saved-1', USER, {
    enabled: true,
    evidence: { via: 'web_form', path: '/account/searches' },
  });

  const granted = consent.granted[0] as { kind: string; channel: string; evidence: Record<string, unknown> };
  assert.equal(granted.kind, 'saved_search_alert');
  assert.equal(granted.channel, 'email');
  assert.equal(granted.evidence['via'], 'web_form');
  assert.equal(granted.evidence['searchName'], 'Two beds');
  assert.ok(granted.evidence['grantedAt'], 'and when');
});

test('a search belonging to someone else is not found, and not modified', async () => {
  const { svc, sql } = harness({ rows: { 'SELECT name, alert_enabled': [] } });
  await assert.rejects(
    () => svc.setAlert('saved-1', 'someone-else', { enabled: true }),
    (err: { status?: number }) => err.status === 404,
  );
  assert.ok(!sql.some((q) => q.includes('UPDATE saved_searches')));
});

// ── what is due ─────────────────────────────────────────────────────────────

test('only alerts with a consent id are ever due', async () => {
  // Belt and braces with the CHECK constraint. If a row somehow reached the
  // forbidden state, the query that decides who gets email still skips it.
  const { svc, sql } = harness();
  await svc.due();
  const q = sql.find((t) => t.includes('FROM saved_searches s'))!;
  assert.match(q, /alert_enabled = true/);
  assert.match(q, /consent_id IS NOT NULL/);
  assert.match(q, /u\.status = 'active'/);
});

test('the due interval is decided in SQL, per row', async () => {
  // Filtering in memory would fetch every enabled alert on every run and
  // discard most of them, and the LIMIT would become a limit on rows READ
  // rather than on work done.
  const { svc, sql } = harness();
  await svc.due();
  const q = sql.find((t) => t.includes('FROM saved_searches s'))!;
  assert.match(q, /CASE s\.frequency/);
  for (const [freq, hours] of Object.entries(INTERVAL_HOURS)) {
    const expected = hours < 24 ? `${hours} hour` : hours === 24 ? '24 hours' : '7 days';
    assert.ok(
      q.includes(expected),
      `the SQL and INTERVAL_HOURS disagree about ${freq}: expected ${expected}`,
    );
  }
});

test('saving WITH alerts on grants consent and stores its id', async () => {
  // The route the UI does not currently take, but the service allows — and if
  // it ever did take it, the row must still be impossible to write in the
  // state the CHECK constraint forbids.
  const { svc, consent, params } = harness();
  await svc.save({
    userId: USER, name: 'Two beds', spec: { minBeds: 2 },
    alertEnabled: true, evidence: { via: 'api' },
  });

  assert.equal(consent.granted.length, 1, 'consent must be recorded');
  const insert = params.find((p) => p.length === 6)!;
  assert.equal(insert[4], true, 'alert_enabled');
  assert.equal(insert[5], 'consent-1', 'and the id of the consent just granted');
});

test('a consent failure while saving prevents the insert entirely', async () => {
  // Granting happens BEFORE the insert precisely so this is true: a consent
  // store that is down is a failure to save, not a saved search that is
  // marked as alerting with no consent behind it.
  const { svc, sql } = harness({ grantThrows: true });
  await assert.rejects(
    () => svc.save({ userId: USER, name: 'Two beds', spec: {}, alertEnabled: true }),
  );
  assert.ok(!sql.some((q) => q.startsWith('INSERT INTO saved_searches')));
});
