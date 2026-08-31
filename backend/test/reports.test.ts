/**
 * Report tests.
 *
 * The design problem here is corroboration, not collection — writing a row is
 * easy. So most of these assert the difference between ten people reporting
 * one listing (evidence) and one person reporting it ten times (an opinion,
 * or a grudge), because a count(*) cannot tell them apart and a queue built
 * on the wrong one is a brigading tool.
 *
 * The database half — the partial unique index that refuses the second, the
 * queue's ON CONFLICT — is asserted against real PostgreSQL in
 * test/sql/reports.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ReportService, corroborationFactor, REPORT_KINDS,
} from '../src/modules/trust/reports.js';
import { AppError } from '../src/lib/errors.js';
import type { Sql, QueryResult } from '../src/db/pool.js';

const REPORTER = '22222222-2222-4222-8222-222222222222';
const STAFF = { userId: '99999999-9999-4999-8999-999999999999', role: 'staff' as const };
const LISTING = 'bbbbbbbb-1111-4111-8111-111111111111';

interface Stmt { text: string; params: readonly unknown[]; on: string }

function reportDb(opts: {
  subjectExists?: boolean;
  distinctReporters?: number;
  insertThrows?: unknown;
  openReports?: number;
} = {}) {
  const statements: Stmt[] = [];
  const handle = (on: string): Sql => ({
    async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
      const t = text.replace(/\s+/g, ' ').trim();
      statements.push({ text: t, params, on });

      if (/^SELECT 1 FROM \w+ WHERE id = \$1$/.test(t)) {
        return opts.subjectExists === false
          ? { rows: [], rowCount: 0 }
          : { rows: [{} as R], rowCount: 1 };
      }
      if (t.startsWith('INSERT INTO reports')) {
        if (opts.insertThrows) throw opts.insertThrows;
        return {
          rows: [{
            id: 'report-1', subject_type: params[1], subject_id: params[2],
            kind: params[3], detail: params[4], severity: params[5],
            status: 'open', created_at: new Date('2026-08-31T12:00:00Z'),
          } as R],
          rowCount: 1,
        };
      }
      if (t.includes('count(DISTINCT reporter_id)')) {
        return {
          rows: [{ n: String(opts.distinctReporters ?? 1), worst: '3' } as R],
          rowCount: 1,
        };
      }
      if (t.startsWith('UPDATE reports')) {
        const n = opts.openReports ?? 1;
        return { rows: [], rowCount: n };
      }
      return { rows: [], rowCount: 1 };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> { return fn(handle('tx')); },
  });
  return Object.assign(handle('db'), { statements });
}

function svc(opts: Parameters<typeof reportDb>[0] = {}) {
  const db = reportDb(opts);
  const audited: Array<Record<string, unknown>> = [];
  const reports = new ReportService({
    db,
    audit: { async record(_tx, e) { audited.push(e as never); } },
  });
  return { db, reports, audited };
}

const find = (db: { statements: Stmt[] }, needle: string) =>
  db.statements.find((s) => s.text.includes(needle));

// ── corroboration ───────────────────────────────────────────────────────────

test('corroboration is sub-linear and capped', () => {
  // The second reporter roughly doubles the evidence; the tenth adds little
  // the first three did not. Linear scaling is what turns a report button
  // into a brigading tool.
  assert.equal(corroborationFactor(0), 1);
  assert.equal(corroborationFactor(1), 1);
  assert.equal(corroborationFactor(2), 2);
  assert.ok(corroborationFactor(10) < 5, 'ten reporters must not be ten times one');
  assert.equal(corroborationFactor(1000), 3, 'and it caps');
  assert.equal(corroborationFactor(1_000_000), 3);
});

test('corroboration never decreases as reporters are added', () => {
  let prev = 0;
  for (let n = 0; n <= 200; n++) {
    const f = corroborationFactor(n);
    assert.ok(f >= prev, `factor fell at n=${n}`);
    prev = f;
  }
});

test('a second reporter raises the queue score; the same reporter cannot', async () => {
  const alone = svc({ distinctReporters: 1 });
  await alone.reports.create({
    reporterId: REPORTER, subjectType: 'listing', subjectId: LISTING, kind: 'scam',
  });
  const scoreAlone = Number(find(alone.db, 'INSERT INTO moderation_queue')!.params[3]);

  const corroborated = svc({ distinctReporters: 3 });
  await corroborated.reports.create({
    reporterId: 'someone-else', subjectType: 'listing', subjectId: LISTING, kind: 'scam',
  });
  const scoreThree = Number(find(corroborated.db, 'INSERT INTO moderation_queue')!.params[3]);

  assert.ok(scoreThree > scoreAlone, 'three people saying it must outrank one');
  assert.ok(scoreThree < scoreAlone * 3, 'but not by three times');
});

test('a duplicate report from the same person is refused, not silently accepted', async () => {
  // "Thanks, we got it" for a report that changed nothing teaches people the
  // button does not work.
  const { reports } = svc({
    insertThrows: Object.assign(new Error('dup'), {
      code: '23505', constraint: 'reports_one_open_per_reporter_idx',
    }),
  });
  await assert.rejects(
    () => reports.create({
      reporterId: REPORTER, subjectType: 'listing', subjectId: LISTING, kind: 'scam',
    }),
    (err: AppError) => err.status === 409 && /already reported/i.test(err.message),
  );
});

// ── severity ────────────────────────────────────────────────────────────────

test('already_rented does not outrank scam', async () => {
  // The most common report on any classifieds site is also the least
  // alarming. Treating it as equal to fraud buries real fraud under
  // housekeeping, which is how a queue stops being read.
  const stale = svc({ distinctReporters: 5 });
  await stale.reports.create({
    reporterId: REPORTER, subjectType: 'listing', subjectId: LISTING, kind: 'already_rented',
  });
  const staleScore = Number(find(stale.db, 'INSERT INTO moderation_queue')!.params[3]);

  const scam = svc({ distinctReporters: 1 });
  await scam.reports.create({
    reporterId: REPORTER, subjectType: 'listing', subjectId: LISTING, kind: 'scam',
  });
  const scamScore = Number(find(scam.db, 'INSERT INTO moderation_queue')!.params[3]);

  assert.ok(scamScore > staleScore, 'one scam report must outrank five "already rented"');
});

test('the queue score only ever goes up for a subject', async () => {
  // GREATEST in the ON CONFLICT: a stream of low-severity reports must not
  // drag a subject DOWN the queue below where one scam report put it.
  const { db, reports } = svc();
  await reports.create({
    reporterId: REPORTER, subjectType: 'listing', subjectId: LISTING, kind: 'duplicate',
  });
  const stmt = find(db, 'INSERT INTO moderation_queue')!;
  assert.match(stmt.text, /GREATEST\(moderation_queue\.risk_score, EXCLUDED\.risk_score\)/);
});

test('every declared kind has a weight and a severity', async () => {
  for (const kind of REPORT_KINDS) {
    const { db, reports } = svc();
    await reports.create({
      reporterId: REPORTER, subjectType: 'listing', subjectId: LISTING, kind,
      detail: 'because',
    });
    const insert = find(db, 'INSERT INTO reports')!;
    assert.ok(
      ['low', 'normal', 'high', 'critical'].includes(String(insert.params[5])),
      `${kind} must map to a real severity`,
    );
    const queued = Number(find(db, 'INSERT INTO moderation_queue')!.params[3]);
    assert.ok(queued > 0, `${kind} must be worth something in the queue`);
  }
});

// ── what a report cannot do ─────────────────────────────────────────────────

test('reports never act on their own — nothing here touches the listing', async () => {
  // Forty accounts is an afternoon's work for someone motivated. An
  // auto-takedown at five reports makes Portage weaponisable against a
  // competitor; reports raise queue position and a human still decides.
  const { db, reports } = svc({ distinctReporters: 500 });
  await reports.create({
    reporterId: REPORTER, subjectType: 'listing', subjectId: LISTING, kind: 'scam',
  });
  assert.ok(!db.statements.some((s) => /UPDATE listings/.test(s.text)),
    'no number of reports may change a listing');
  assert.ok(!db.statements.some((s) => /status = .(rejected|paused|expired)./.test(s.text)));
});

test('the reporter is told nothing about the queue', async () => {
  // Telling a reporter how close their report came to acting is a scoreboard
  // for anyone testing how many accounts it takes.
  const { reports } = svc({ distinctReporters: 4 });
  const out = await reports.create({
    reporterId: REPORTER, subjectType: 'listing', subjectId: LISTING, kind: 'scam',
  });
  const keys = Object.keys(out);
  assert.ok(!keys.includes('riskScore'));
  assert.ok(!keys.includes('queuePosition'));
});

test('a report against something that does not exist is a 404', async () => {
  // And the same 404 as "you cannot see it", so the endpoint is not a way to
  // probe which listing ids are real.
  const { reports } = svc({ subjectExists: false });
  await assert.rejects(
    () => reports.create({
      reporterId: REPORTER, subjectType: 'listing', subjectId: LISTING, kind: 'scam',
    }),
    (err: AppError) => err.status === 404,
  );
});

test('"other" without an explanation is refused', async () => {
  // An item a moderator opens, learns nothing from, and closes. Asking for
  // one sentence is cheaper than that, for everyone.
  const { reports } = svc();
  await assert.rejects(
    () => reports.create({
      reporterId: REPORTER, subjectType: 'listing', subjectId: LISTING, kind: 'other',
    }),
    (err: AppError) => err.status === 400,
  );
  // ...but with a sentence it goes through.
  await reports.create({
    reporterId: REPORTER, subjectType: 'listing', subjectId: LISTING,
    kind: 'other', detail: 'The owner asked me to e-transfer before viewing.',
  });
});

test('an over-long detail is refused rather than truncated', async () => {
  const { reports } = svc();
  await assert.rejects(
    () => reports.create({
      reporterId: REPORTER, subjectType: 'listing', subjectId: LISTING,
      kind: 'scam', detail: 'x'.repeat(4001),
    }),
    (err: AppError) => err.status === 400,
  );
});

// ── closing them ────────────────────────────────────────────────────────────

test('deciding closes every open report on the subject in one transaction', async () => {
  // A moderator looks at the listing once and reaches one conclusion. Closing
  // eight reports individually is how the eighth gets left open — and an open
  // report is what keeps a subject in the queue.
  const { db, reports, audited } = svc({ openReports: 8 });
  const out = await reports.decide('listing', LISTING, 'resolved', STAFF);

  assert.equal(out.closed, 8);
  assert.equal(find(db, 'UPDATE reports')!.on, 'tx');
  assert.equal(find(db, 'UPDATE moderation_queue')!.on, 'tx');
  assert.equal(audited.length, 1);
  assert.equal(audited[0]!['action'], 'report.resolve');
  assert.equal(audited[0]!['subjectId'], LISTING);
});

test('dismissing is a different audit action from resolving', async () => {
  // "I read these and there is nothing here" and "I read these and acted" are
  // different facts, and the trail has to be able to tell them apart later.
  const { audited, reports } = svc();
  await reports.decide('listing', LISTING, 'dismissed', STAFF);
  assert.equal(audited[0]!['action'], 'report.dismiss');
});

test('deciding with nothing open is a 404, not a silent success', async () => {
  const { reports } = svc({ openReports: 0 });
  await assert.rejects(
    () => reports.decide('listing', LISTING, 'resolved', STAFF),
    (err: AppError) => err.status === 404,
  );
});

test('closing reports does not itself act on the listing', async () => {
  // "I have read these" and "I have taken it down" are separate, separately
  // audited decisions. Collapsing them loses which one happened.
  const { db, reports } = svc({ openReports: 3 });
  await reports.decide('listing', LISTING, 'resolved', STAFF);
  assert.ok(!db.statements.some((s) => /UPDATE listings/.test(s.text)));
});

test('the staff IP reaches the audit entry for hashing', async () => {
  const { audited, reports } = svc();
  await reports.decide('listing', LISTING, 'resolved', { ...STAFF, ip: '198.51.100.7' });
  assert.equal(audited[0]!['ip'], '198.51.100.7');
});
