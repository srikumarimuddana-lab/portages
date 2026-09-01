/**
 * Admin tests: the audit trail, the moderation queue, and staff review of
 * withheld messages.
 *
 * The property under test throughout is that a STAFF DECISION AND ITS RECORD
 * ARE ONE THING. Every assertion about `record()` here is really an assertion
 * about which Sql handle it was given, because that — not the presence of an
 * INSERT somewhere in the file — is what makes the pair atomic.
 *
 * The database's own guarantees (the append-only trigger on `audit_log`, the
 * queue's state transitions, the uniqueness that stops a double release) are
 * asserted against real PostgreSQL in test/sql/admin.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AUDIT_ACTIONS, AuditService, type AuditAction } from '../src/modules/audit/service.js';
import { ModerationService } from '../src/modules/admin/moderation.js';
import { MessagingService } from '../src/modules/messaging/service.js';
import { AppError } from '../src/lib/errors.js';
import { pseudonymize } from '../src/lib/crypto.js';
import type { Sql, QueryResult } from '../src/db/pool.js';

const PEPPER = 'test-pepper-value';
const STAFF = { userId: '99999999-9999-4999-8999-999999999999', role: 'staff' as const };
const OWNER = '11111111-1111-4111-8111-111111111111';
const INQUIRER = '22222222-2222-4222-8222-222222222222';

// ── a recording Sql ─────────────────────────────────────────────────────────

interface Stmt { text: string; params: readonly unknown[]; on: string }

/**
 * A fake Sql that remembers which HANDLE each statement ran on.
 *
 * `transaction()` hands the callback a DISTINCT object tagged 'tx', so a test
 * can tell "wrote inside the transaction" from "wrote next to it". Every other
 * fake in this repo returns the same object for both, which cannot distinguish
 * the two — and that distinction is the entire safety property of the audit
 * writer.
 */
function recordingDb(
  reply: (text: string, params: readonly unknown[]) => unknown[] | undefined = () => undefined,
): Sql & { statements: Stmt[] } {
  const statements: Stmt[] = [];

  const handle = (on: string): Sql => ({
    async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
      const t = text.replace(/\s+/g, ' ').trim();
      statements.push({ text: t, params, on });
      const rows = (reply(t, params) ?? []) as R[];
      return { rows, rowCount: rows.length };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      return fn(handle('tx'));
    },
  });

  const db = handle('db') as Sql & { statements: Stmt[] };
  db.statements = statements;
  return db;
}

const find = (db: { statements: Stmt[] }, needle: string) =>
  db.statements.find((s) => s.text.includes(needle));

// ── the audit trail ─────────────────────────────────────────────────────────

test('audit: actions are unique and namespaced subject.verb', () => {
  // A duplicate or a variant spelling ('listing.approved' beside
  // 'listing.approve') produces rows that nobody finds when they search for
  // the other one.
  assert.equal(new Set(AUDIT_ACTIONS).size, AUDIT_ACTIONS.length);
  for (const action of AUDIT_ACTIONS) {
    assert.match(action, /^[a-z]+\.[a-z_]+$/, `${action} must be subject.verb`);
  }
});

test('audit: record writes on the Sql it is handed, not one of its own', async () => {
  const audit = new AuditService(PEPPER);
  const db = recordingDb();

  await db.transaction(async (tx) => {
    await tx.query('UPDATE listings SET status = $1', ['live']);
    await audit.record(tx, {
      actorId: STAFF.userId, actorRole: STAFF.role,
      action: 'listing.approve', subject: 'listing', subjectId: 'listing-1',
    });
  });

  const insert = find(db, 'INSERT INTO audit_log')!;
  assert.ok(insert, 'the entry must be written');
  assert.equal(
    insert.on, 'tx',
    'the entry must run in the caller\'s transaction, or a decision can commit without its record',
  );
});

test('audit: the IP is hashed, and the raw address never reaches the row', async () => {
  const audit = new AuditService(PEPPER);
  const db = recordingDb();

  await audit.record(db, {
    actorId: STAFF.userId, actorRole: STAFF.role,
    action: 'message.release', subject: 'message', subjectId: 'message-1',
    ip: '198.51.100.7',
  });

  const params = find(db, 'INSERT INTO audit_log')!.params;
  const ipHash = params[7];
  assert.ok(Buffer.isBuffer(ipHash), 'ip_hash must be the digest, not the string');
  assert.deepEqual(ipHash, pseudonymize('198.51.100.7', PEPPER));
  for (const p of params) {
    assert.notEqual(p, '198.51.100.7', 'no parameter may carry the address in the clear');
  }
});

test('audit: before and after are serialized, and absent when there is nothing to say', async () => {
  const audit = new AuditService(PEPPER);
  const db = recordingDb();

  await audit.record(db, {
    actorId: STAFF.userId, actorRole: STAFF.role,
    action: 'listing.reject', subject: 'listing', subjectId: 'listing-1',
    before: { status: 'pending_review' },
    after: { status: 'rejected', reason: 'Photos are of a different property.' },
  });
  const withState = find(db, 'INSERT INTO audit_log')!.params;
  assert.equal(withState[5], JSON.stringify({ status: 'pending_review' }));
  assert.match(String(withState[6]), /different property/);

  const db2 = recordingDb();
  await audit.record(db2, {
    actorId: STAFF.userId, actorRole: STAFF.role,
    action: 'report.dismiss', subject: 'report', subjectId: 'report-1',
  });
  const bare = find(db2, 'INSERT INTO audit_log')!.params;
  assert.equal(bare[5], null);
  assert.equal(bare[6], null);
  assert.equal(bare[7], null, 'no IP means no hash, not a hash of undefined');
});

test('audit: list clamps the limit and pages on the id', async () => {
  const audit = new AuditService(PEPPER);
  const db = recordingDb(() => []);

  await audit.list(db, { limit: 100_000 });
  assert.equal(find(db, 'FROM audit_log')!.params[0], 200, 'an unbounded limit must be capped');

  const db2 = recordingDb(() => []);
  await audit.list(db2, { limit: 0 });
  assert.equal(find(db2, 'FROM audit_log')!.params[0], 1);

  const db3 = recordingDb(() => []);
  await audit.list(db3, { beforeId: '4210', action: 'listing.approve' as AuditAction });
  const stmt = find(db3, 'FROM audit_log')!;
  assert.ok(stmt.text.includes('ORDER BY id DESC'), 'newest first');
  assert.ok(!stmt.text.includes('OFFSET'), 'keyset, not offset');
  assert.equal(stmt.params[1], '4210');
  assert.equal(stmt.params[2], 'listing.approve');
});

// ── the moderation queue ────────────────────────────────────────────────────

const AT = new Date('2026-08-31T12:00:00Z');
const clock = () => AT;

const queueRow = (over: Record<string, unknown> = {}) => ({
  id: 'queue-1',
  subject_type: 'listing',
  subject_id: 'listing-1',
  reason: 'owner_submitted',
  risk_score: 12,
  state: 'open',
  created_at: new Date(AT.getTime() - 90 * 60_000),
  listing_title: 'Bright two bedroom',
  price_cents: '150000',
  listing_mode: 'rent',
  listing_beds: 2,
  address_line: '2100 Victoria Ave',
  city: 'Regina',
  message_body: null,
  moderation_verdict: null,
  sender_email: null,
  message_listing_title: null,
  ...over,
});

function queueDb(rows: Record<string, unknown>[], signals: Record<string, unknown>[] = []) {
  return recordingDb((t) => {
    if (t.includes('FROM moderation_queue q')) return rows;
    if (t.includes('FROM risk_signals')) return signals;
    return [];
  });
}

test('queue: ordered by risk then age, which is the index it has', async () => {
  const db = queueDb([queueRow()]);
  await new ModerationService(db, { now: clock }).list();

  const stmt = find(db, 'FROM moderation_queue q')!;
  assert.ok(
    stmt.text.includes('ORDER BY q.risk_score DESC, q.created_at'),
    'any other order stops using moderation_queue_open_idx',
  );
});

test('queue: signals for a whole page are fetched in one query', async () => {
  const rows = [
    queueRow({ id: 'q1', subject_id: 's1' }),
    queueRow({ id: 'q2', subject_id: 's2' }),
    queueRow({ id: 'q3', subject_id: 's3' }),
  ];
  const db = queueDb(rows, [
    { subject_id: 's1', signal: 'price_outlier', weight: '30', detail: {}, at: AT },
    { subject_id: 's3', signal: 'new_account', weight: '10', detail: {}, at: AT },
  ]);

  const items = await new ModerationService(db, { now: clock }).list();

  const signalQueries = db.statements.filter((s) => s.text.includes('FROM risk_signals'));
  assert.equal(signalQueries.length, 1, 'one query for the page, not one per row');
  assert.deepEqual(signalQueries[0]!.params[0], ['s1', 's2', 's3']);
  assert.equal(items[0]!.signals[0]!.signal, 'price_outlier');
  assert.equal(items[0]!.signals[0]!.weight, 30, 'the weight arrives as a number, not "30"');
  assert.deepEqual(items[1]!.signals, [], 'a subject with no signals gets an empty list, not undefined');
});

test('queue: an empty page skips the signals query entirely', async () => {
  const db = queueDb([]);
  const items = await new ModerationService(db, { now: clock }).list();
  assert.deepEqual(items, []);
  assert.equal(db.statements.filter((s) => s.text.includes('FROM risk_signals')).length, 0);
});

test('queue: waiting time is measured, not guessed', async () => {
  const db = queueDb([queueRow()]);
  const items = await new ModerationService(db, { now: clock }).list();
  assert.equal(items[0]!.waitingSec, 90 * 60);
});

test('queue: a clock skew cannot produce a negative wait', async () => {
  // created_at in the future — a replica a second ahead is enough. "-2s waiting"
  // on the dashboard reads as a bug in the queue, not in the clock.
  const db = queueDb([queueRow({ created_at: new Date(AT.getTime() + 5_000) })]);
  const items = await new ModerationService(db, { now: clock }).list();
  assert.equal(items[0]!.waitingSec, 0);
});

test('queue: a listing row reads as an address and a price', async () => {
  const db = queueDb([queueRow()]);
  const [item] = await new ModerationService(db, { now: clock }).list();
  assert.equal(item!.title, '2100 Victoria Ave · Regina');
  assert.match(item!.subtitle, /^listing · \$1,500\/mo · 2 bed$/);
});

test('queue: a message row does NOT quote the body in the list', async () => {
  // The list is scanned on a laptop in public. The body of a flagged message
  // is exactly the text that should not be legible over a shoulder; it is on
  // the review screen, behind a deliberate click.
  const body = 'Wire the deposit to account 4004 and I will courier the keys.';
  const db = queueDb([queueRow({
    subject_type: 'message', subject_id: 'message-1', risk_score: 130,
    listing_title: null, price_cents: null, listing_mode: null, listing_beds: null,
    address_line: null, city: null,
    message_body: body, moderation_verdict: 'block',
    sender_email: 'sender@example.test', message_listing_title: 'Bright two bedroom',
  })]);

  const [item] = await new ModerationService(db, { now: clock }).list();
  assert.equal(item!.title, 'Message from sender@example.test');
  assert.equal(item!.subtitle, 'block · Bright two bedroom');
  const rendered = JSON.stringify(item);
  assert.ok(!rendered.includes('Wire the deposit'), 'the list must not carry the body');
  assert.ok(!rendered.includes('4004'));
});

test('queue: the state and subject filters are parameters, never interpolated', async () => {
  const db = queueDb([]);
  await new ModerationService(db, { now: clock }).list({ state: 'rejected', subjectType: 'message' });
  const stmt = find(db, 'FROM moderation_queue q')!;
  assert.ok(!stmt.text.includes('rejected'), 'the value must not appear in the SQL text');
  assert.equal(stmt.params[2], 'rejected');
  assert.equal(stmt.params[3], 'message');
});

test('queue: limit and offset are clamped', async () => {
  const db = queueDb([]);
  const svc = new ModerationService(db, { now: clock });
  await svc.list({ limit: 5000, offset: -10 });
  const stmt = find(db, 'FROM moderation_queue q')!;
  assert.equal(stmt.params[0], 100);
  assert.equal(stmt.params[1], 0);
});

test('queue: an unknown item is a 404, not an empty object', async () => {
  const db = queueDb([]);
  await assert.rejects(
    () => new ModerationService(db, { now: clock }).get('nope'),
    (err: AppError) => err.status === 404,
  );
});

test('queue: dismissing an already-decided item is refused', async () => {
  // The UPDATE is guarded by `state = 'open'`, so a second moderator clicking
  // the same stale row changes nothing — and must be told so, rather than
  // being shown a success for work that did not happen.
  const db = recordingDb(() => []);
  await assert.rejects(
    () => new ModerationService(db, { now: clock }).dismiss('queue-1', STAFF.userId),
    (err: AppError) => err.status === 404,
  );
  const stmt = find(db, 'UPDATE moderation_queue')!;
  assert.ok(stmt.text.includes("state = 'open'"), 'the guard must be in the WHERE clause');
});

test('queue: stats leads with the age of the oldest open item', async () => {
  // At two to five items a day the failure is not a deep queue, it is a queue
  // nobody opened for a week. Depth alone cannot show that.
  const db = recordingDb(() => [{
    open: '3', open_listings: '2', open_messages: '1',
    oldest: new Date(AT.getTime() - 6 * 24 * 3600_000),
    blocked: '11', released: '4',
  }]);
  const stats = await new ModerationService(db, { now: clock }).stats();
  assert.equal(stats.oldestWaitingSec, 6 * 24 * 3600);
  assert.equal(stats.open, 3);
  assert.equal(stats.blockedLast7d, 11);
  assert.equal(stats.releasedLast7d, 4, 'blocked without released cannot tell over-firing from attack');
});

test('queue: an empty queue reports null age, not zero', async () => {
  // Zero would mean "an item arrived this instant". Null means there is none.
  const db = recordingDb(() => [{
    open: '0', open_listings: '0', open_messages: '0',
    oldest: null, blocked: '0', released: '0',
  }]);
  const stats = await new ModerationService(db, { now: clock }).stats();
  assert.equal(stats.oldestWaitingSec, null);
});

// ── staff review of withheld messages ───────────────────────────────────────

const withheld = (over: Record<string, unknown> = {}) => ({
  id: 'message-1', thread_id: 'thread-1', sender_id: INQUIRER,
  body: 'I am abroad, wire the deposit and I will courier the keys.',
  moderation_verdict: 'block', flagged_reasons: ['money_request'],
  delivered_at: null, is_first_contact: true, created_at: AT,
  owner_id: OWNER, inquirer_id: INQUIRER, listing_id: 'listing-1',
  listing_title: 'Bright two bedroom',
  sender_email: 'sender@example.test', sender_verified: null,
  ...over,
});

function messagingDb(message: Record<string, unknown> | null, over: Record<string, unknown[]> = {}) {
  return recordingDb((t) => {
    if (t.includes('FROM messages m')) return message ? [message] : [];
    if (t.startsWith('SELECT id, moderation_verdict, delivered_at FROM messages')) {
      return message ? [message] : [];
    }
    if (t.includes('count(*)::text AS n FROM messages')) return over.priors ?? [{ n: '2' }];
    if (t.includes('FROM messages WHERE thread_id')) return over.context ?? [];
    if (t.includes('FROM users WHERE id')) return [{ email: 'recipient@example.test' }];
    return [];
  });
}

function messagingSvc(db: Sql) {
  const sent: unknown[] = [];
  const audited: unknown[] = [];
  const messaging = new MessagingService({
    db,
    notify: { async send(i: unknown) { sent.push(i); return { ok: true }; } } as never,
    appOrigin: 'https://portage.ca',
    now: () => AT,
    audit: { async record(_tx: Sql, e: unknown) { audited.push(e); } },
  });
  return { messaging, sent, audited };
}

test('review: the one read path that returns an undelivered body', async () => {
  const db = messagingDb(withheld());
  const { messaging } = messagingSvc(db);
  const out = await messaging.reviewMessage('message-1', STAFF);

  assert.equal(out.delivered, false);
  assert.match(out.body, /wire the deposit/);
  assert.equal(out.verdict, 'block');

  // Every other read in the module filters on delivery. This one must not, or
  // there is nobody who can see that the scanner got one wrong.
  const target = find(db, 'FROM messages m')!;
  assert.ok(
    !target.text.includes('delivered_at IS NOT NULL'),
    'the message under review must be readable precisely because it was withheld',
  );
  // ...but the surrounding thread still is, so review does not become a
  // back door onto everything else the scanner is still holding.
  const context = find(db, 'FROM messages WHERE thread_id')!;
  assert.ok(context.text.includes('delivered_at IS NOT NULL'));
});

test('review: prior blocks by the sender come with it', async () => {
  const db = messagingDb(withheld(), { priors: [{ n: '3' }] });
  const { messaging } = messagingSvc(db);
  const out = await messaging.reviewMessage('message-1', STAFF);
  assert.equal(out.sender.blockedCount, 3, 'a first offence and a fourth are different decisions');
  assert.equal(out.sender.emailVerified, false);

  const stmt = find(db, 'count(*)::text AS n FROM messages')!;
  assert.ok(stmt.text.includes('id <> $2'), 'the message being reviewed must not count as its own prior');
});

test('review: the recipient is derived from the thread, not from the request', async () => {
  const db = messagingDb(withheld({ sender_id: OWNER }));
  const { messaging } = messagingSvc(db);
  const out = await messaging.reviewMessage('message-1', STAFF);
  assert.equal(out.recipient.id, INQUIRER, 'the owner writing means the inquirer receives');
});

test('release: delivers as of now, not backdated to when it was written', async () => {
  // Three days up the thread is where a released message goes to be unread.
  const db = messagingDb(withheld({ created_at: new Date(AT.getTime() - 3 * 24 * 3600_000) }));
  const { messaging } = messagingSvc(db);

  const out = await messaging.release('message-1', STAFF);
  assert.equal(out.delivered, true);

  const stmt = find(db, 'SET delivered_at = $2')!;
  assert.equal(stmt.params[1], AT);
  assert.ok(stmt.text.includes("moderation_verdict = 'allow'"), 'the verdict is corrected, not left as block');
});

test('release: the decision, the thread bump, the queue and the record are one transaction', async () => {
  const db = messagingDb(withheld());
  const { messaging, audited } = messagingSvc(db);
  await messaging.release('message-1', STAFF);

  for (const needle of ['SET delivered_at = $2', 'message_count = message_count + 1', 'UPDATE moderation_queue']) {
    assert.equal(find(db, needle)!.on, 'tx', `${needle} must be inside the transaction`);
  }
  assert.equal(audited.length, 1);
  assert.deepEqual(audited[0], {
    actorId: STAFF.userId, actorRole: 'staff',
    action: 'message.release', subject: 'message', subjectId: 'message-1',
    before: { verdict: 'block', delivered: false },
    after: { verdict: 'allow', delivered: true },
    ip: undefined,
  });
});

test('release: the row is locked before it is read', async () => {
  // Two moderators on the same item is the whole reason the double-release
  // check below can be trusted; without the lock both read "not delivered".
  const db = messagingDb(withheld());
  const { messaging } = messagingSvc(db);
  await messaging.release('message-1', STAFF);
  assert.ok(find(db, 'FROM messages m')!.text.includes('FOR UPDATE OF m'));
});

test('release: a message already delivered is refused', async () => {
  const db = messagingDb(withheld({ delivered_at: AT }));
  const { messaging, sent } = messagingSvc(db);
  await assert.rejects(
    () => messaging.release('message-1', STAFF),
    (err: AppError) => err.status === 409,
  );
  assert.equal(sent.length, 0, 'a second release must not send a second notification');
});

test('release: an unknown message is a 404', async () => {
  const db = messagingDb(null);
  const { messaging } = messagingSvc(db);
  await assert.rejects(
    () => messaging.release('nope', STAFF),
    (err: AppError) => err.status === 404,
  );
});

test('release: the recipient is told, and told after the decision is committed', async () => {
  const db = messagingDb(withheld());
  const { messaging, sent } = messagingSvc(db);
  await messaging.release('message-1', STAFF);

  assert.equal(sent.length, 1);
  const notification = sent[0] as { template: string; vars: Record<string, string>; userId: string };
  assert.equal(notification.template, 'message_received');
  assert.equal(notification.userId, OWNER);

  // The lookup that feeds the send runs on the pool, not the transaction —
  // which is how we know the mail is outside it. A moderator's decision must
  // not roll back because SES was down.
  const lookup = db.statements.filter((s) => s.text.includes('FROM users WHERE id = $1'));
  assert.ok(lookup.some((s) => s.on === 'db'), 'notification lookup must be outside the transaction');
});

test('release: the notification carries a preview, because the verdict is now allow', async () => {
  // Blocked mail deliberately omits the body. A released message has been read
  // by a human and judged fine, so withholding the preview would leave the
  // recipient with a notice about a message they cannot see the shape of.
  const db = messagingDb(withheld({ body: 'Hi, I am abroad this week but interested.' }));
  const { messaging, sent } = messagingSvc(db);
  await messaging.release('message-1', STAFF);
  const vars = (sent[0] as { vars: Record<string, string> }).vars;
  assert.ok(vars.preview!.length > 0, 'a released message is previewable');
});

test('uphold: the message stays withheld and the queue entry closes as rejected', async () => {
  const db = messagingDb(withheld());
  const { messaging, sent, audited } = messagingSvc(db);
  await messaging.uphold('message-1', STAFF);

  assert.ok(!find(db, 'SET delivered_at'), 'upholding must never deliver');
  assert.equal(sent.length, 0, 'and must never notify — the recipient was never meant to see it');

  const queue = find(db, 'UPDATE moderation_queue')!;
  assert.equal(queue.on, 'tx');
  assert.equal(queue.params[1], STAFF.userId);
  assert.ok(queue.text.includes("state = 'rejected'"));
  assert.ok(queue.text.includes("state = 'open'"), 'only an open entry is closed by this decision');

  assert.equal((audited[0] as { action: string }).action, 'message.uphold');
});

test('uphold: a delivered message cannot be un-delivered', async () => {
  // There is no way to reach into an inbox and remove what is already there,
  // so pretending the block held would only make the record wrong.
  const db = messagingDb(withheld({ delivered_at: AT }));
  const { messaging } = messagingSvc(db);
  await assert.rejects(
    () => messaging.uphold('message-1', STAFF),
    (err: AppError) => err.status === 409,
  );
});

test('review: a staff IP reaches the audit entry hashed', async () => {
  const db = messagingDb(withheld());
  const { messaging, audited } = messagingSvc(db);
  await messaging.release('message-1', { ...STAFF, ip: '198.51.100.7' });
  assert.equal((audited[0] as { ip: string }).ip, '198.51.100.7');

  // The service passes it through; AuditService is what hashes it. Prove the
  // pair, so neither half can be changed alone.
  const real = new AuditService(PEPPER);
  const sink = recordingDb();
  await real.record(sink, audited[0] as never);
  assert.deepEqual(
    find(sink, 'INSERT INTO audit_log')!.params[7],
    pseudonymize('198.51.100.7', PEPPER),
  );
});

test('messaging without an audit recorder still works, and is a deliberate default', async () => {
  // The composition root always injects one. This asserts the optional
  // dependency does not throw, so a missing wire fails loudly at review time
  // rather than at 2am inside a transaction.
  const db = messagingDb(withheld());
  const messaging = new MessagingService({
    db,
    notify: { async send() { return { ok: true }; } } as never,
    appOrigin: 'https://portage.ca',
    now: () => AT,
  });
  await messaging.uphold('message-1', STAFF);
  assert.ok(find(db, 'UPDATE moderation_queue'));
  assert.ok(!find(db, 'INSERT INTO audit_log'));
});
