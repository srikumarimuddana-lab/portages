/**
 * Messaging tests.
 *
 * The moderation half is pure and gets the most attention, because it is the
 * part that decides whether a scam reaches someone's inbox — and because the
 * design claim it rests on (that the same sentence means different things at
 * different points in a conversation) is only true if the code actually
 * behaves that way.
 *
 * Database behaviour — the thread uniqueness index, the block consistency
 * constraint, unread counting — is asserted against real PostgreSQL in
 * test/sql/messaging.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_AT, BLOCKED_NOTICE, ESTABLISHED_AFTER, FLAG_AT,
  previewFor, riskScoreOf, scanMessage,
} from '../src/modules/messaging/policy.js';
import { MessagingService } from '../src/modules/messaging/service.js';
import { AppError } from '../src/lib/errors.js';
import type { Sql, QueryResult } from '../src/db/pool.js';

const scan = (body: string, over: { count?: number; owner?: boolean } = {}) =>
  scanMessage({
    body,
    threadMessageCount: over.count ?? 0,
    senderIsOwner: over.owner ?? false,
  });

// ── the money script blocks, always ──────────────────────────────────────────

test('moderation: asking for payment before a viewing is blocked outright', () => {
  const r = scan('Please wire the deposit and I will send the keys.');
  assert.equal(r.verdict, 'block');
  assert.ok(r.score >= BLOCK_AT);
});

test('moderation: the money script blocks in an ESTABLISHED thread too', () => {
  // The patient scammer: three polite messages, then the pivot. Thread
  // maturity must buy nothing here.
  const r = scan('Please wire the deposit before viewing.', { count: 50 });
  assert.equal(r.verdict, 'block');
});

test('moderation: every money phrase is caught on its own', () => {
  for (const phrase of [
    'send it by western union', 'moneygram is easiest', 'wire transfer only',
    'I take payment in bitcoin', 'buy a gift card', 'a cashier cheque is fine',
    'deposit before viewing please', 'renting it sight unseen',
  ]) {
    assert.equal(scan(phrase).verdict, 'block', `"${phrase}" must block`);
  }
});

test('moderation: the absent-landlord script is flagged, and blocks with anything else', () => {
  // People do travel, so this alone is not proof — but combined with a link
  // or a phone number it clears the bar at once.
  const alone = scan('I am currently abroad but the flat is available.');
  assert.equal(alone.verdict, 'flag');

  const combined = scan('I am currently abroad. Text me at 306-555-0134.');
  assert.equal(combined.verdict, 'block');
});

// ── maturity changes the meaning ─────────────────────────────────────────────

test('moderation: a phone number in a FIRST message is flagged', () => {
  const r = scan('Hi, is this still available? Call me on 306-555-0134.');
  assert.equal(r.verdict, 'flag');
  assert.ok(r.signals.some((s) => s.reason.startsWith('contact_details')));
});

test('moderation: the same phone number in an established thread is fine', () => {
  // This is the whole design claim. Two people who have talked about the unit
  // and agreed to meet are swapping numbers, which is the point of the site.
  const r = scan('Great — my number is 306-555-0134, text me Saturday.',
    { count: ESTABLISHED_AFTER });
  assert.equal(r.verdict, 'allow');
});

test('moderation: the maturity threshold is where it says it is', () => {
  const body = 'Reach me on WhatsApp';
  assert.equal(scan(body, { count: ESTABLISHED_AFTER - 1 }).verdict, 'flag');
  assert.equal(scan(body, { count: ESTABLISHED_AFTER }).verdict, 'allow');
});

test('moderation: an obfuscated email is still an email', () => {
  // Someone writing "me (at) example (dot) com" is evading a filter, which is
  // itself the signal.
  for (const body of [
    'write to me at me@example.com',
    'reach me: me (at) example (dot) com',
    'contact me [at] example.com',
  ]) {
    const r = scan(body);
    assert.ok(r.signals.some((s) => s.reason.includes('email')), `"${body}"`);
  }
});

test('moderation: a spaced-out phone number is still a phone number', () => {
  assert.ok(scan('call 306 555 0134').signals.some((s) => s.reason.includes('phone')));
  assert.ok(scan('306.555.0134').signals.some((s) => s.reason.includes('phone')));
  assert.ok(scan('(306) 555-0134').signals.some((s) => s.reason.includes('phone')));
});

test('moderation: a link is weighted down once the thread is established', () => {
  const first = scan('See the floor plan at https://example.com/plan');
  const later = scan('See the floor plan at https://example.com/plan',
    { count: ESTABLISHED_AFTER });
  assert.ok(first.score > later.score, 'a link matters more from a stranger');
  assert.equal(later.verdict, 'allow');
});

// ── ordinary messages pass ───────────────────────────────────────────────────

test('moderation: a normal enquiry is allowed and raises nothing', () => {
  for (const body of [
    'Hi, is this still available? I could view it this weekend.',
    'Are utilities included in the rent?',
    'Does the unit come with parking? I have one car.',
    'Thanks — I will take it. What are the next steps?',
  ]) {
    const r = scan(body);
    assert.equal(r.verdict, 'allow', `"${body}" must pass`);
    assert.deepEqual(r.signals, [], `"${body}" must raise nothing`);
  }
});

test('moderation: urgency alone is noted but does not flag', () => {
  // Plenty of honest urgency exists; on its own it is not worth a warning.
  const r = scan('There are three other people interested, let me know soon.');
  assert.ok(r.score > 0 && r.score < FLAG_AT);
  assert.equal(r.verdict, 'allow');
});

test('moderation: a price with many digits is not a phone number', () => {
  const r = scan('The rent is $1,450 and the deposit is $1,450.');
  assert.equal(r.verdict, 'allow');
  assert.deepEqual(r.signals, []);
});

// ── the "already gone" nudge ─────────────────────────────────────────────────

test('moderation: an owner saying it is rented is a nudge, not a violation', () => {
  const r = scan('Sorry, it is already rented.', { owner: true });
  assert.equal(r.suggestsClosed, true);
  assert.equal(r.verdict, 'allow', 'it must still be delivered');
});

test('moderation: the same words from an inquirer are not a nudge', () => {
  // A prospective tenant asking "is it already rented?" must not close a
  // listing.
  const r = scan('Is it already rented?', { owner: false });
  assert.equal(r.suggestsClosed, false);
});

// ── what the sender is told ──────────────────────────────────────────────────

test('notice: the block message does not name the rule that fired', () => {
  // Naming it is a free tuning loop for the next attempt.
  assert.ok(!/wire|bitcoin|western union|regex|pattern/i.test(BLOCKED_NOTICE));
  assert.ok(BLOCKED_NOTICE.length > 40, 'and it should still be useful advice');
});

test('preview: a flagged message gets no preview', () => {
  // Otherwise the message we warn about in-app arrives in full in an inbox,
  // which is the one place the warning is not.
  assert.equal(previewFor('wire me the deposit', 'flag'), null);
  assert.equal(previewFor('wire me the deposit', 'block'), null);
  assert.equal(previewFor('Is it still available?', 'allow'), 'Is it still available?');
});

test('preview: long text is cut on a word boundary', () => {
  const long = 'word '.repeat(80);
  const p = previewFor(long, 'allow', 40)!;
  assert.ok(p.length <= 41, `got ${p.length}`);
  assert.ok(p.endsWith('…'));
  assert.ok(!p.includes('  '), 'whitespace should be collapsed');
});

test('risk score is bounded so one message cannot dominate the queue', () => {
  const many = Array.from({ length: 500 }, () => ({ reason: 'x', weight: 100, absolute: true }));
  assert.ok(riskScoreOf(many) <= 9999);
});

// ── the service, against a fake Sql ──────────────────────────────────────────

const OWNER = '11111111-1111-4111-8111-111111111111';
const INQUIRER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';

interface Fixture {
  listing?: { id: string; owner_id: string; status: string; title: string } | null;
  thread?: Record<string, unknown> | null;
  existingThread?: Record<string, unknown> | null;
}

function fakeDb(f: Fixture): Sql & { statements: Array<{ text: string; params: readonly unknown[] }> } {
  const statements: Array<{ text: string; params: readonly unknown[] }> = [];
  const db: Sql & { statements: typeof statements } = {
    statements,
    async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
      statements.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      const t = text.replace(/\s+/g, ' ').trim();

      if (t.startsWith('SELECT id, owner_id, status, title FROM listings')) {
        return f.listing
          ? { rows: [f.listing as unknown as R], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (t.includes('FROM threads WHERE listing_id')) {
        return f.existingThread
          ? { rows: [f.existingThread as unknown as R], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (t.includes('FROM threads WHERE id')) {
        return f.thread
          ? { rows: [f.thread as unknown as R], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (t.startsWith('INSERT INTO threads')) {
        return { rows: [{ id: 'thread-1' } as unknown as R], rowCount: 1 };
      }
      if (t.startsWith('INSERT INTO messages')) {
        return { rows: [{ id: 'message-1' } as unknown as R], rowCount: 1 };
      }
      if (t.includes('SELECT title FROM listings')) {
        return { rows: [{ title: 'Bright two bedroom' } as unknown as R], rowCount: 1 };
      }
      if (t.includes('SELECT email FROM users')) {
        return { rows: [{ email: 'owner@example.test' } as unknown as R], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> { return fn(db); },
  };
  return db;
}

interface SentNotification { template: string; vars: Record<string, unknown> }

function fakeNotify(): { send(input: unknown): Promise<unknown>; sent: SentNotification[] } {
  const sent: SentNotification[] = [];
  return {
    sent,
    async send(input: unknown) {
      const i = input as SentNotification;
      sent.push(i);
      return { ok: true };
    },
  };
}

const LIVE_LISTING = { id: 'listing-1', owner_id: OWNER, status: 'live', title: 'Bright two bedroom' };

const openThread = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'thread-1', listing_id: 'listing-1', owner_id: OWNER, inquirer_id: INQUIRER,
  status: 'open', message_count: 0, last_at: new Date(),
  owner_read_at: null, inquirer_read_at: null, blocked_by: null, ...over,
});

function svc(f: Fixture) {
  const db = fakeDb(f);
  const notify = fakeNotify();
  return {
    db,
    notify,
    messaging: new MessagingService({
      db,
      notify: notify as never,
      appOrigin: 'https://portage.ca',
    }),
  };
}

test('service: an enquiry on a live listing opens a thread and notifies the owner', async () => {
  const { messaging, notify } = svc({ listing: LIVE_LISTING });
  const out = await messaging.startThread({
    listingId: 'listing-1', inquirerId: INQUIRER,
    body: 'Hi, is this still available?',
  });
  assert.equal(out.ok, true);
  assert.equal(out.threadId, 'thread-1');
  assert.equal(notify.sent.length, 1);
  assert.equal(notify.sent[0]?.template, 'message_received');
});

test('service: an enquiry on a draft listing is refused as not found', async () => {
  // A draft is private, so its existence must not be confirmed.
  const { messaging } = svc({ listing: { ...LIVE_LISTING, status: 'draft' } });
  await assert.rejects(
    () => messaging.startThread({ listingId: 'listing-1', inquirerId: INQUIRER, body: 'hi there' }),
    (err: AppError) => err.status === 404,
  );
});

test('service: an enquiry on a paused listing is refused the same way', async () => {
  const { messaging } = svc({ listing: { ...LIVE_LISTING, status: 'paused' } });
  await assert.rejects(
    () => messaging.startThread({ listingId: 'listing-1', inquirerId: INQUIRER, body: 'hi there' }),
    (err: AppError) => err.status === 404,
  );
});

test('service: an owner cannot enquire about their own listing', async () => {
  const { messaging } = svc({ listing: LIVE_LISTING });
  await assert.rejects(
    () => messaging.startThread({ listingId: 'listing-1', inquirerId: OWNER, body: 'hello' }),
    (err: AppError) => err.status === 400,
  );
});

test('service: an empty message is refused', async () => {
  const { messaging } = svc({ listing: LIVE_LISTING });
  await assert.rejects(
    () => messaging.startThread({ listingId: 'listing-1', inquirerId: INQUIRER, body: '   ' }),
    (err: AppError) => err.status === 400,
  );
});

test('service: a blocked message is recorded but never delivered or notified', async () => {
  const { messaging, notify, db } = svc({ listing: LIVE_LISTING });
  const out = await messaging.startThread({
    listingId: 'listing-1', inquirerId: INQUIRER,
    body: 'Wire the deposit and I will courier the keys.',
  });

  assert.equal(out.ok, false);
  assert.equal(out.verdict, 'block');
  assert.equal(out.notice, BLOCKED_NOTICE);
  assert.equal(notify.sent.length, 0, 'the recipient must not be told it exists');

  const insert = db.statements.find((s) => s.text.startsWith('INSERT INTO messages'))!;
  assert.ok(insert, 'the attempt must still be recorded for moderation');
  // delivered_at is parameter 6 and must be null.
  assert.equal(insert.params[5], null);

  assert.ok(
    db.statements.some((s) => s.text.startsWith('INSERT INTO moderation_queue')),
    'and it must reach the moderation queue',
  );
  assert.ok(
    !db.statements.some((s) => s.text.includes('SET last_at')),
    'a blocked message must not bump the thread in anyone\'s inbox',
  );
});

test('service: a flagged message IS delivered, with no preview in the email', async () => {
  const { messaging, notify } = svc({ listing: LIVE_LISTING });
  const out = await messaging.startThread({
    listingId: 'listing-1', inquirerId: INQUIRER,
    body: 'Is it available? Call me on 306-555-0134.',
  });
  assert.equal(out.ok, true);
  assert.equal(out.verdict, 'flag');
  assert.equal(notify.sent.length, 1);
  assert.equal(notify.sent[0]?.vars['preview'], '', 'a flagged body must not travel by email');
});

test('service: a delivered message bumps the thread and carries a preview', async () => {
  const { messaging, notify, db } = svc({ listing: LIVE_LISTING });
  await messaging.startThread({
    listingId: 'listing-1', inquirerId: INQUIRER, body: 'Is this still available?',
  });
  assert.ok(db.statements.some((s) => s.text.includes('SET last_at')));
  assert.equal(notify.sent[0]?.vars['preview'], 'Is this still available?');
});

test('service: a second enquiry reuses the existing thread', async () => {
  // threads_unique_idx allows one per (listing, inquirer); starting a parallel
  // conversation would give the owner two threads to reconcile.
  const { messaging, db } = svc({
    listing: LIVE_LISTING,
    existingThread: { id: 'thread-existing', status: 'open', blocked_by: null },
  });
  const out = await messaging.startThread({
    listingId: 'listing-1', inquirerId: INQUIRER, body: 'Following up on this.',
  });
  assert.equal(out.threadId, 'thread-existing');
  assert.ok(!db.statements.some((s) => s.text.startsWith('INSERT INTO threads')));
});

test('service: a stranger cannot read a thread, and is told it does not exist', async () => {
  const { messaging } = svc({ thread: openThread() });
  await assert.rejects(
    () => messaging.getThread('thread-1', STRANGER),
    (err: AppError) => err.status === 404,   // not 403: that confirms it is real
  );
});

test('service: a stranger cannot reply either', async () => {
  const { messaging } = svc({ thread: openThread() });
  await assert.rejects(
    () => messaging.reply({ threadId: 'thread-1', senderId: STRANGER, body: 'hello' }),
    (err: AppError) => err.status === 404,
  );
});

test('service: posting to a blocked thread fails the same way for either party', async () => {
  // The blocked party must not be able to tell the difference between being
  // blocked and being ignored, so both sides get the identical response.
  for (const sender of [OWNER, INQUIRER]) {
    const { messaging } = svc({ thread: openThread({ status: 'blocked', blocked_by: OWNER }) });
    await assert.rejects(
      () => messaging.reply({ threadId: 'thread-1', senderId: sender, body: 'hello' }),
      (err: AppError) => err.status === 403 && /no longer accepting/.test(err.message),
    );
  }
});

test('service: only the person who blocked may unblock', async () => {
  const { messaging } = svc({ thread: openThread({ status: 'blocked', blocked_by: OWNER }) });
  await assert.rejects(
    () => messaging.unblock('thread-1', INQUIRER),
    (err: AppError) => err.status === 403,
  );
  // The blocker can.
  const asOwner = svc({ thread: openThread({ status: 'blocked', blocked_by: OWNER }) });
  await assert.doesNotReject(() => asOwner.messaging.unblock('thread-1', OWNER));
});

test('service: blocking is idempotent', async () => {
  const { messaging, db } = svc({ thread: openThread({ status: 'blocked', blocked_by: OWNER }) });
  await messaging.block('thread-1', OWNER);
  assert.ok(!db.statements.some((s) => s.text.includes("SET status = 'blocked'")));
});

test('service: reply moderation uses the thread\'s message count', async () => {
  // An established thread must let a phone number through; the count comes
  // from the thread row, not from the caller.
  const established = svc({ thread: openThread({ message_count: 10 }) });
  const out = await established.messaging.reply({
    threadId: 'thread-1', senderId: OWNER, body: 'Text me on 306-555-0134.',
  });
  assert.equal(out.verdict, 'allow');

  const fresh = svc({ thread: openThread({ message_count: 0 }) });
  const out2 = await fresh.messaging.reply({
    threadId: 'thread-1', senderId: OWNER, body: 'Text me on 306-555-0134.',
  });
  assert.equal(out2.verdict, 'flag');
});

test('service: an owner replying "already rented" gets the close nudge', async () => {
  const { messaging } = svc({ thread: openThread({ message_count: 3 }) });
  const out = await messaging.reply({
    threadId: 'thread-1', senderId: OWNER, body: 'Sorry, it is already rented.',
  });
  assert.equal(out.suggestsClosed, true);
});

test('service: an inquirer saying the same thing does not', async () => {
  const { messaging } = svc({ thread: openThread({ message_count: 3 }) });
  const out = await messaging.reply({
    threadId: 'thread-1', senderId: INQUIRER, body: 'Is it already rented?',
  });
  assert.equal(out.suggestsClosed, undefined);
});

test('service: a notification failure does not fail the send', async () => {
  const db = fakeDb({ listing: LIVE_LISTING });
  const messaging = new MessagingService({
    db,
    notify: { async send() { throw new Error('SES is down'); } } as never,
    appOrigin: 'https://portage.ca',
  });
  // The message is already written and visible in the inbox; the email is a
  // nudge, and losing it must not lose the message.
  const out = await messaging.startThread({
    listingId: 'listing-1', inquirerId: INQUIRER, body: 'Is this available?',
  });
  assert.equal(out.ok, true);
});

test('service: marking read proves party membership in the WHERE clause', async () => {
  const { messaging, db } = svc({ thread: openThread() });
  await messaging.markRead('thread-1', INQUIRER);
  const stmt = db.statements.find((s) => s.text.includes('owner_read_at ='))!;
  assert.ok(
    stmt.text.includes('owner_id = $2 OR inquirer_id = $2'),
    'the update must not be able to touch a thread the caller is not in',
  );
});

test('service: threads for a listing are refused to a non-owner', async () => {
  const db = fakeDb({});
  const messaging = new MessagingService({
    db, notify: fakeNotify() as never, appOrigin: 'https://portage.ca',
  });
  // The ownership SELECT returns nothing for a stranger.
  db.query = (async (text: string) => {
    if (text.includes('FROM listings WHERE id = $1 AND owner_id = $2')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  }) as never;

  await assert.rejects(
    () => messaging.threadsForListing('listing-1', STRANGER),
    (err: AppError) => err.status === 404,
  );
});

test('service: an archived thread cannot be archived past a block', async () => {
  const { messaging } = svc({ thread: openThread({ status: 'blocked', blocked_by: OWNER }) });
  await assert.rejects(
    () => messaging.archive('thread-1', OWNER, true),
    (err: AppError) => err.status === 409,
  );
});
