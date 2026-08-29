/**
 * Notification layer tests.
 *
 * The important assertions here are negative: a message without consent must
 * not leave the building, a suppressed address must not be contacted, and a
 * retried job must not send twice. Those are the properties with a $10M
 * penalty attached.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideConsent,
  explainDenial,
  type ConsentRow,
} from '../src/modules/notify/consent.js';
import {
  renderTemplate,
  escapeHtml,
  TEMPLATE_IDS,
  isCommercial,
} from '../src/modules/notify/templates.js';
import {
  NotifyService,
  normalizeDestination,
  idempotencyKeyFor,
  type KillSwitch,
} from '../src/modules/notify/service.js';
import { EmailChannel } from '../src/modules/notify/channels/email.js';
import { SmsChannel, isE164, segmentCount } from '../src/modules/notify/channels/sms.js';
import { WhatsAppChannel } from '../src/modules/notify/channels/whatsapp.js';
import {
  ChannelError,
  NotConfiguredError,
  isRetryableStatus,
  backoffMs,
} from '../src/modules/notify/channels/types.js';
import { signRequest, formEncode, rfc3986, toAmzDate } from '../src/lib/awssig.js';
import type { Sql, QueryResult } from '../src/db/pool.js';

// ── consent ─────────────────────────────────────────────────────────────────
const live: ConsentRow = {
  kind: 'saved_search_alert', channel: 'email',
  grantedAt: new Date('2026-01-01'), expiresAt: null, revokedAt: null,
};

test('consent: transactional needs no express consent', () => {
  const v = decideConsent({ category: 'transactional', channel: 'email', consents: [], suppressed: false });
  assert.deepEqual(v, { allowed: true, reason: 'transactional' });
});

test('consent: LEGAL — an alert with no consent row is refused', () => {
  const v = decideConsent({ category: 'saved_search_alert', channel: 'email', consents: [], suppressed: false });
  assert.equal(v.allowed, false);
  if (!v.allowed) assert.equal(v.reason, 'no_consent_on_record');
});

test('consent: LEGAL — marketing consent does not authorise alerts, or vice versa', () => {
  const marketingOnly: ConsentRow = { ...live, kind: 'marketing' };
  const v = decideConsent({
    category: 'saved_search_alert', channel: 'email',
    consents: [marketingOnly], suppressed: false,
  });
  assert.equal(v.allowed, false);
});

test('consent: LEGAL — consent for email does not authorise SMS', () => {
  const v = decideConsent({
    category: 'saved_search_alert', channel: 'sms',
    consents: [live], suppressed: false,
  });
  assert.equal(v.allowed, false);
});

test('consent: a live express consent allows the send', () => {
  const v = decideConsent({
    category: 'saved_search_alert', channel: 'email',
    consents: [live], suppressed: false,
  });
  assert.deepEqual(v, { allowed: true, reason: 'express_consent' });
});

test('consent: revoked consent is refused, and reported as revoked', () => {
  const v = decideConsent({
    category: 'saved_search_alert', channel: 'email',
    consents: [{ ...live, revokedAt: new Date('2026-02-01') }],
    suppressed: false, now: new Date('2026-03-01'),
  });
  assert.equal(v.allowed, false);
  if (!v.allowed) assert.equal(v.reason, 'consent_revoked');
});

test('consent: expired consent is refused', () => {
  const v = decideConsent({
    category: 'saved_search_alert', channel: 'email',
    consents: [{ ...live, expiresAt: new Date('2026-02-01') }],
    suppressed: false, now: new Date('2026-03-01'),
  });
  assert.equal(v.allowed, false);
  if (!v.allowed) assert.equal(v.reason, 'consent_expired');
});

test('consent: suppression beats consent, even for transactional', () => {
  // Someone who marked us as spam gets nothing, however good our paperwork.
  for (const category of ['transactional', 'saved_search_alert', 'marketing'] as const) {
    const v = decideConsent({ category, channel: 'email', consents: [live], suppressed: true });
    assert.equal(v.allowed, false, `${category} must be blocked when suppressed`);
    if (!v.allowed) assert.equal(v.reason, 'suppressed');
  }
});

test('consent: a user preference toggle blocks non-transactional sends', () => {
  const v = decideConsent({
    category: 'saved_search_alert', channel: 'email',
    consents: [live], suppressed: false, preferenceEnabled: false,
  });
  assert.equal(v.allowed, false);
  if (!v.allowed) assert.equal(v.reason, 'user_preference_off');
});

test('consent: one live consent among revoked ones still allows', () => {
  const v = decideConsent({
    category: 'saved_search_alert', channel: 'email',
    consents: [{ ...live, revokedAt: new Date('2026-01-02') }, live],
    suppressed: false, now: new Date('2026-03-01'),
  });
  assert.equal(v.allowed, true);
});

test('consent: every denial has an operator explanation', () => {
  for (const r of ['no_consent_on_record','consent_revoked','consent_expired','suppressed','user_preference_off'] as const) {
    assert.ok(explainDenial(r).length > 15);
  }
});

// ── templates ───────────────────────────────────────────────────────────────
test('template: substitutes variables', () => {
  const m = renderTemplate('otp_email', { code: '123456', minutes: 10 });
  assert.ok(m.text.includes('123456'));
  assert.ok(m.text.includes('10 minutes'));
  assert.equal(m.subject, 'Your Portage verification code');
});

test('template: SECURITY — user content is escaped in the HTML part', () => {
  const m = renderTemplate('saved_search_alert', {
    count: 3,
    searchName: '<script>alert(1)</script>',
    link: 'https://portage.ca/x',
  });
  assert.ok(m.html);
  assert.ok(!m.html!.includes('<script>'), 'raw script tag must not survive');
  assert.ok(m.html!.includes('&lt;script&gt;'));
});

test('template: text part is not HTML-escaped', () => {
  const m = renderTemplate('saved_search_alert', { count: 1, searchName: 'Cats & Dogs', link: 'x' });
  assert.ok(m.text.includes('Cats & Dogs'));
});

test('template: missing variables render as empty, not as placeholders', () => {
  const m = renderTemplate('otp_email', {});
  assert.ok(!m.text.includes('{{'));
});

test('template: commercial messages carry an unsubscribe line', () => {
  const alert = renderTemplate('saved_search_alert', { count: 1, searchName: 'x', link: 'y' });
  assert.ok(alert.text.toLowerCase().includes('unsubscribe'));
  assert.equal(isCommercial('saved_search_alert'), true);
});

test('template: transactional messages carry sender identification', () => {
  const otp = renderTemplate('otp_email', { code: '1', minutes: 5 });
  assert.ok(otp.text.includes('Portage'));
  assert.ok(otp.text.includes('portage.ca'));
  // ...but no unsubscribe: there is nothing to unsubscribe from.
  assert.ok(!otp.text.toLowerCase().includes('unsubscribe'));
});

test('template: the SMS OTP fits one billable segment', () => {
  const m = renderTemplate('otp_sms', { code: '123456', minutes: 10 });
  assert.equal(segmentCount(m.text), 1, `SMS was ${m.text.length} chars`);
});

test('template: every declared template renders', () => {
  for (const id of TEMPLATE_IDS) {
    const m = renderTemplate(id, { code: '1', minutes: 1, count: 1, link: 'https://x' });
    assert.ok(m.text.length > 0, `${id} produced no text`);
  }
});

test('escapeHtml: handles all five dangerous characters', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

// ── channels ────────────────────────────────────────────────────────────────
test('channel: unconfigured channels report it rather than throwing late', () => {
  assert.equal(new EmailChannel(null).isConfigured(), false);
  assert.equal(new SmsChannel(null).isConfigured(), false);
  assert.equal(new WhatsAppChannel().isConfigured(), false);
});

test('channel: whatsapp is a deliberate stub', async () => {
  await assert.rejects(
    () => new WhatsAppChannel().send({ to: '+15551234567', text: 'x', idempotencyKey: 'k' }),
    NotConfiguredError,
  );
});

test('channel: retryable classification separates transient from permanent', () => {
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(403), false);
});

test('channel: backoff grows and stays capped', () => {
  const cap = 5 * 60_000;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const ms = backoffMs(attempt);
    assert.ok(ms >= 0 && ms <= cap, `attempt ${attempt} gave ${ms}`);
  }
});

test('sms: E.164 validation', () => {
  assert.equal(isE164('+13065551234'), true);
  assert.equal(isE164('3065551234'), false);
  assert.equal(isE164('+0305551234'), false);
  assert.equal(isE164('+1 306 555 1234'), false);
});

test('sms: invalid number fails without a provider call and is not retryable', async () => {
  let called = false;
  const ch = new SmsChannel({
    region: 'ca-central-1',
    credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    originationIdentity: 'pool-1',
    fetchImpl: (async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; }) as never,
  });
  await assert.rejects(
    () => ch.send({ to: '306-555-1234', text: 'hi', idempotencyKey: 'k' }),
    (e: unknown) => e instanceof ChannelError && e.retryable === false,
  );
  assert.equal(called, false, 'must not call the provider with an invalid number');
});

test('email: a signed request carries the SigV4 authorization header', async () => {
  let seen: { url: string; headers: Record<string, string> } | null = null;
  const ch = new EmailChannel({
    region: 'ca-central-1',
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'secret' },
    fromAddress: 'Portage <no-reply@portage.ca>',
    fetchImpl: (async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return { ok: true, status: 200, json: async () => ({ MessageId: 'msg-1' }) };
    }) as never,
  });

  const receipt = await ch.send({ to: 'a@b.com', subject: 's', text: 't', idempotencyKey: 'k' });
  assert.equal(receipt.providerMessageId, 'msg-1');
  assert.ok(seen);
  assert.ok(seen!.url.startsWith('https://email.ca-central-1.amazonaws.com/'));
  assert.match(seen!.headers['authorization']!, /^AWS4-HMAC-SHA256 Credential=/);
  assert.ok(seen!.headers['x-amz-date']);
});

test('email: a 400 from SES is not retried; a 500 is', async () => {
  const make = (status: number) => new EmailChannel({
    region: 'ca-central-1',
    credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    fromAddress: 'x@y.com',
    fetchImpl: (async () => ({ ok: false, status, json: async () => ({ message: 'nope' }) })) as never,
  });
  await assert.rejects(
    () => make(400).send({ to: 'a@b.com', text: 't', idempotencyKey: 'k' }),
    (e: unknown) => e instanceof ChannelError && e.retryable === false,
  );
  await assert.rejects(
    () => make(503).send({ to: 'a@b.com', text: 't', idempotencyKey: 'k' }),
    (e: unknown) => e instanceof ChannelError && e.retryable === true,
  );
});

// ── AWS SigV4 ───────────────────────────────────────────────────────────────
test('sigv4: signature is deterministic for fixed inputs', () => {
  const args = {
    method: 'POST', host: 'email.ca-central-1.amazonaws.com',
    path: '/v2/email/outbound-emails', body: '{"a":1}',
    service: 'ses', region: 'ca-central-1',
    credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
    now: new Date('2026-08-29T00:00:00Z'),
  };
  assert.equal(signRequest(args).headers['authorization'], signRequest(args).headers['authorization']);
});

test('sigv4: a changed body changes the signature', () => {
  const base = {
    method: 'POST', host: 'h.amazonaws.com', path: '/', service: 'ses',
    region: 'ca-central-1', credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
    now: new Date('2026-08-29T00:00:00Z'),
  };
  const a = signRequest({ ...base, body: '{"a":1}' }).headers['authorization'];
  const b = signRequest({ ...base, body: '{"a":2}' }).headers['authorization'];
  assert.notEqual(a, b);
});

test('sigv4: a changed secret changes the signature', () => {
  const base = {
    method: 'POST', host: 'h.amazonaws.com', path: '/', body: 'x', service: 'ses',
    region: 'ca-central-1', now: new Date('2026-08-29T00:00:00Z'),
  };
  const a = signRequest({ ...base, credentials: { accessKeyId: 'AKID', secretAccessKey: 'S1' } });
  const b = signRequest({ ...base, credentials: { accessKeyId: 'AKID', secretAccessKey: 'S2' } });
  assert.notEqual(a.headers['authorization'], b.headers['authorization']);
});

test('sigv4: the secret never appears in the signed output', () => {
  const s = signRequest({
    method: 'POST', host: 'h.amazonaws.com', path: '/', body: 'x', service: 'ses',
    region: 'ca-central-1',
    credentials: { accessKeyId: 'AKID', secretAccessKey: 'super-secret-value' },
  });
  const serialized = JSON.stringify(s);
  assert.ok(!serialized.includes('super-secret-value'));
});

test('sigv4: signed headers list is sorted and includes host and date', () => {
  const s = signRequest({
    method: 'POST', host: 'h.amazonaws.com', path: '/', body: '',
    service: 'ses', region: 'ca-central-1',
    credentials: { accessKeyId: 'A', secretAccessKey: 'B' },
    headers: { 'Content-Type': 'application/json' },
  });
  const m = /SignedHeaders=([^,]+)/.exec(s.headers['authorization']!);
  const names = m![1]!.split(';');
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('host'));
  assert.ok(names.includes('x-amz-date'));
});

test('sigv4: session token is signed when present', () => {
  const s = signRequest({
    method: 'GET', host: 'h.amazonaws.com', path: '/', service: 'ses',
    region: 'ca-central-1',
    credentials: { accessKeyId: 'A', secretAccessKey: 'B', sessionToken: 'tok' },
  });
  assert.equal(s.headers['x-amz-security-token'], 'tok');
  assert.ok(s.headers['authorization']!.includes('x-amz-security-token'));
});

test('sigv4: amz date format', () => {
  assert.equal(toAmzDate(new Date('2026-08-29T12:34:56.789Z')), '20260829T123456Z');
});

test('sigv4: rfc3986 encodes the characters encodeURIComponent leaves alone', () => {
  assert.equal(rfc3986("!'()*"), '%21%27%28%29%2A');
  assert.equal(formEncode({ b: '2', a: '1' }), 'a=1&b=2');
});

// ── service ─────────────────────────────────────────────────────────────────
interface Row { [k: string]: unknown }

function fakeDb(): Sql & { deliveries: Row[]; suppressed: Set<string>; consents: Row[] } {
  const deliveries: Row[] = [];
  const suppressed = new Set<string>();
  const consents: Row[] = [];

  const db = {
    deliveries, suppressed, consents,
    async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
      const t = text.replace(/\s+/g, ' ').trim();

      if (t.startsWith('INSERT INTO notification_deliveries')) {
        const key = String(params[5]);
        if (deliveries.some((d) => d['idempotency_key'] === key)) {
          return { rows: [], rowCount: 0 };   // ON CONFLICT DO NOTHING
        }
        const row: Row = {
          id: `d-${deliveries.length + 1}`, user_id: params[0], destination: params[1],
          channel: params[2], template: params[3], category: params[4],
          idempotency_key: key, status: 'pending', attempts: 0,
        };
        deliveries.push(row);
        return { rows: [{ id: row['id'] } as R], rowCount: 1 };
      }
      if (t.startsWith('SELECT id FROM notification_deliveries')) {
        const hit = deliveries.find((d) => d['idempotency_key'] === params[0]);
        return { rows: hit ? [{ id: hit['id'] } as R] : [], rowCount: hit ? 1 : 0 };
      }
      if (t.startsWith('UPDATE notification_deliveries')) {
        const hit = deliveries.find((d) => d['id'] === params[0]);
        if (hit) {
          hit['status'] = params[1];
          if (params[2]) hit['provider_message_id'] = params[2];
          if (params[3]) hit['last_error'] = params[3];
        }
        return { rows: [], rowCount: hit ? 1 : 0 };
      }
      if (t.startsWith('SELECT 1 FROM suppressions')) {
        const key = `${params[0]}:${params[1]}`;
        return { rows: [], rowCount: suppressed.has(key) ? 1 : 0 };
      }
      if (t.startsWith('INSERT INTO suppressions')) {
        suppressed.add(`${params[0]}:${params[1]}`);
        return { rows: [], rowCount: 1 };
      }
      if (t.startsWith('SELECT kind, channel, granted_at')) {
        const rows = consents.filter((c) => c['user_id'] === params[0] && c['kind'] === params[1] && c['channel'] === params[2]);
        return { rows: rows as R[], rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> { return fn(db); },
  } as Sql & { deliveries: Row[]; suppressed: Set<string>; consents: Row[] };
  return db;
}

function okEmail(sent: string[]): EmailChannel {
  return new EmailChannel({
    region: 'ca-central-1',
    credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    fromAddress: 'x@portage.ca',
    fetchImpl: (async (_u: string, init: { body: string }) => {
      sent.push(init.body);
      return { ok: true, status: 200, json: async () => ({ MessageId: `m-${sent.length}` }) };
    }) as never,
  });
}

test('service: a transactional message sends without consent', async () => {
  const sent: string[] = [];
  const db = fakeDb();
  const svc = new NotifyService(db, [okEmail(sent)]);
  const r = await svc.send({
    to: 'User@Example.com', channel: 'email', template: 'otp_email',
    vars: { code: '123456', minutes: 10 }, category: 'transactional',
    idempotencyKey: 'otp-1',
  });
  assert.equal(r.status, 'sent');
  assert.equal(sent.length, 1);
});

test('service: LEGAL — an alert without consent never reaches the provider', async () => {
  const sent: string[] = [];
  const db = fakeDb();
  const svc = new NotifyService(db, [okEmail(sent)]);
  const r = await svc.send({
    to: 'a@b.com', channel: 'email', template: 'saved_search_alert',
    vars: { count: 2, searchName: 'x', link: 'y' },
    category: 'saved_search_alert', userId: 'u1', idempotencyKey: 'alert-1',
  });
  assert.equal(r.status, 'blocked');
  assert.equal(sent.length, 0, 'no provider call may happen without consent');
});

test('service: LEGAL — a suppressed address is never contacted', async () => {
  const sent: string[] = [];
  const db = fakeDb();
  db.suppressed.add('bounced@example.com:email');
  const svc = new NotifyService(db, [okEmail(sent)]);
  const r = await svc.send({
    to: 'bounced@example.com', channel: 'email', template: 'otp_email',
    vars: { code: '1', minutes: 5 }, category: 'transactional', idempotencyKey: 's-1',
  });
  assert.equal(r.status, 'blocked');
  assert.equal(sent.length, 0);
});

test('service: the same idempotency key sends exactly once', async () => {
  const sent: string[] = [];
  const db = fakeDb();
  const svc = new NotifyService(db, [okEmail(sent)]);
  const input = {
    to: 'a@b.com', channel: 'email' as const, template: 'otp_email' as const,
    vars: { code: '1', minutes: 5 }, category: 'transactional' as const,
    idempotencyKey: 'same-key',
  };
  const first = await svc.send(input);
  const second = await svc.send(input);
  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'duplicate');
  assert.equal(sent.length, 1, 'a retry must not double-send');
});

test('service: the kill switch stops a channel without a provider call', async () => {
  const sent: string[] = [];
  const db = fakeDb();
  const off: KillSwitch = { async isChannelEnabled() { return false; } };
  const svc = new NotifyService(db, [okEmail(sent)], { killSwitch: off });
  const r = await svc.send({
    to: 'a@b.com', channel: 'email', template: 'otp_email',
    vars: { code: '1', minutes: 5 }, category: 'transactional', idempotencyKey: 'k-1',
  });
  assert.equal(r.status, 'blocked');
  if (r.status === 'blocked') assert.equal(r.reason, 'channel_disabled');
  assert.equal(sent.length, 0);
});

test('service: an unconfigured channel fails without pretending to send', async () => {
  const db = fakeDb();
  const svc = new NotifyService(db, [new EmailChannel(null)]);
  const r = await svc.send({
    to: 'a@b.com', channel: 'email', template: 'otp_email',
    vars: {}, category: 'transactional', idempotencyKey: 'nc-1',
  });
  assert.equal(r.status, 'failed');
  if (r.status === 'failed') assert.equal(r.retryable, false);
});

test('service: every attempt is recorded, blocked ones included', async () => {
  const db = fakeDb();
  const svc = new NotifyService(db, [okEmail([])]);
  await svc.send({
    to: 'a@b.com', channel: 'email', template: 'saved_search_alert',
    vars: {}, category: 'marketing', userId: 'u1', idempotencyKey: 'audit-1',
  });
  assert.equal(db.deliveries.length, 1);
  assert.equal(db.deliveries[0]!['status'], 'blocked');
  assert.ok(String(db.deliveries[0]!['last_error']).length > 0);
});

test('normalizeDestination: email lowercased, phone stripped of formatting', () => {
  assert.equal(normalizeDestination('  User@Example.COM ', 'email'), 'user@example.com');
  assert.equal(normalizeDestination('+1 (306) 555-1234', 'sms'), '+13065551234');
});

test('idempotencyKeyFor: stable for the same inputs, different otherwise', () => {
  const a = idempotencyKeyFor({ template: 't', destination: 'd', discriminator: 'x' });
  const b = idempotencyKeyFor({ template: 't', destination: 'd', discriminator: 'x' });
  const c = idempotencyKeyFor({ template: 't', destination: 'd', discriminator: 'y' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
