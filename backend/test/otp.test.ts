/**
 * OTP tests.
 *
 * A six-digit code is only a million possibilities, so the properties that
 * matter are the ones that stop it being guessed: an attempt cap that
 * actually burns the challenge, single use, expiry, and no way to hold two
 * live codes at once. Plus the enumeration discipline — a password-reset
 * request must not reveal whether an account exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OtpService,
  generateCode,
  hashCode,
  codesMatch,
  normalizeIdentifier,
  CODE_LENGTH,
  MAX_ATTEMPTS,
  CODE_TTL_MS,
} from '../src/modules/auth/otp/service.js';
import { OtpFlows, REQUEST_ACK } from '../src/modules/auth/otp/flows.js';
import { AppError } from '../src/lib/errors.js';
import type { Sql, QueryResult } from '../src/db/pool.js';

// ── code generation ─────────────────────────────────────────────────────────
test('code: is six digits and preserves leading zeros', () => {
  for (let i = 0; i < 300; i++) {
    const c = generateCode();
    assert.equal(c.length, CODE_LENGTH);
    assert.match(c, /^\d{6}$/);
  }
});

test('code: distribution is not obviously biased', () => {
  // A modulo-biased generator skews low values. Not a statistical proof, but
  // it catches the classic randomBytes % 1000000 mistake.
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 5000; i++) buckets[Number(generateCode()[0])]! += 1;
  for (const [digit, count] of buckets.entries()) {
    assert.ok(count > 250, `leading digit ${digit} appeared only ${count} times in 5000`);
  }
});

test('code: values are not repeated in short runs', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(generateCode());
  assert.ok(seen.size > 190, `only ${seen.size} distinct codes in 200 draws`);
});

test('hash: the plaintext code is not recoverable from the digest', () => {
  const code = '123456';
  const h = hashCode(code, 'a@b.com');
  assert.equal(h.length, 32);
  assert.ok(!h.toString('hex').includes(code));
});

test('hash: the same code hashes differently for different identifiers', () => {
  // A digest lifted from one challenge must not match another address.
  assert.equal(codesMatch(hashCode('123456', 'a@b.com'), hashCode('123456', 'c@d.com')), false);
});

test('hash: comparison is length-safe', () => {
  assert.equal(codesMatch(Buffer.from('ab'), Buffer.from('abc')), false);
  assert.equal(codesMatch(hashCode('1', 'x'), hashCode('1', 'x')), true);
});

test('normalizeIdentifier: email lowercased, phone stripped', () => {
  assert.equal(normalizeIdentifier(' A@B.COM ', 'email'), 'a@b.com');
  assert.equal(normalizeIdentifier('+1 (306) 555-1234', 'sms'), '+13065551234');
});

// ── fake database ───────────────────────────────────────────────────────────
interface Challenge {
  id: string; user_id: string | null; identifier: string; purpose: string;
  code_hash: Buffer; attempts: number; max_attempts: number;
  expires_at: Date; consumed_at: Date | null; created_at: Date;
}

function fakeDb(): Sql & { challenges: Challenge[]; users: Array<Record<string, unknown>> } {
  const challenges: Challenge[] = [];
  const users: Array<Record<string, unknown>> = [];

  const db = {
    challenges, users,
    async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
      const t = text.replace(/\s+/g, ' ').trim();

      if (t.startsWith('UPDATE otp_challenges SET consumed_at = now() WHERE identifier')) {
        for (const c of challenges) {
          if (c.identifier === params[0] && c.purpose === params[1] && !c.consumed_at) {
            c.consumed_at = new Date();
          }
        }
        return { rows: [], rowCount: 0 };
      }
      if (t.startsWith('INSERT INTO otp_challenges')) {
        const row: Challenge = {
          id: `c-${challenges.length + 1}`,
          user_id: (params[0] as string | null) ?? null,
          identifier: String(params[1]),
          purpose: String(params[3]),
          code_hash: params[4] as Buffer,
          attempts: 0,
          max_attempts: Number(params[5]),
          expires_at: params[6] as Date,
          consumed_at: null,
          created_at: new Date(),
        };
        challenges.push(row);
        return { rows: [{ id: row.id } as R], rowCount: 1 };
      }
      if (t.startsWith('SELECT id, user_id, identifier, code_hash')) {
        const hit = [...challenges]
          .reverse()
          .find((c) => c.identifier === params[0] && c.purpose === params[1] && !c.consumed_at);
        return { rows: hit ? [hit as unknown as R] : [], rowCount: hit ? 1 : 0 };
      }
      if (t.startsWith('UPDATE otp_challenges SET consumed_at = now() WHERE id')) {
        const hit = challenges.find((c) => c.id === params[0]);
        if (hit) hit.consumed_at = new Date();
        return { rows: [], rowCount: hit ? 1 : 0 };
      }
      if (t.startsWith('UPDATE otp_challenges SET attempts')) {
        const hit = challenges.find((c) => c.id === params[0]);
        if (hit) {
          hit.attempts = Number(params[1]);
          if (params[2]) hit.consumed_at = new Date();
        }
        return { rows: [], rowCount: hit ? 1 : 0 };
      }
      if (t.startsWith('SELECT email, email_verified_at FROM users')) {
        const u = users.find((x) => x['id'] === params[0]);
        return { rows: u ? [u as R] : [], rowCount: u ? 1 : 0 };
      }
      if (t.startsWith('SELECT email FROM users')) {
        const u = users.find((x) => x['id'] === params[0]);
        return { rows: u ? [u as R] : [], rowCount: u ? 1 : 0 };
      }
      if (t.startsWith('SELECT id, status FROM users')) {
        const u = users.find((x) => x['email'] === params[0]);
        return { rows: u ? [u as R] : [], rowCount: u ? 1 : 0 };
      }
      if (t.startsWith('UPDATE users')) {
        const u = users.find((x) => x['id'] === params[0]);
        if (u) {
          if (t.includes('email_verified_at = now()')) u['email_verified_at'] = new Date();
          if (t.includes('password_hash')) u['password_hash'] = params[1];
        }
        return { rows: [], rowCount: u ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> { return fn(db); },
  } as Sql & { challenges: Challenge[]; users: Array<Record<string, unknown>> };
  return db;
}

const EMAIL = 'owner@example.com';
function issueArgs(over: Record<string, unknown> = {}) {
  return { identifier: EMAIL, channel: 'email' as const, purpose: 'verify_email' as const, ...over };
}

// ── issue and verify ────────────────────────────────────────────────────────
test('otp: a correct code verifies', async () => {
  const db = fakeDb();
  const svc = new OtpService(db);
  const { code } = await svc.issue(issueArgs());
  const r = await svc.verify({ ...issueArgs(), code });
  assert.equal(r.ok, true);
});

test('otp: a wrong code is rejected and increments attempts', async () => {
  const db = fakeDb();
  const svc = new OtpService(db);
  const { code } = await svc.issue(issueArgs());
  const wrong = code === '000000' ? '111111' : '000000';

  const r = await svc.verify({ ...issueArgs(), code: wrong });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'invalid');
  assert.equal(db.challenges[0]!.attempts, 1);
});

test('otp: SECURITY — a code is single use', async () => {
  const db = fakeDb();
  const svc = new OtpService(db);
  const { code } = await svc.issue(issueArgs());

  assert.equal((await svc.verify({ ...issueArgs(), code })).ok, true);
  const second = await svc.verify({ ...issueArgs(), code });
  assert.equal(second.ok, false, 'a consumed code must not verify again');
});

test('otp: SECURITY — the attempt cap burns the challenge', async () => {
  const db = fakeDb();
  const svc = new OtpService(db);
  const { code } = await svc.issue(issueArgs());
  const wrong = code === '000000' ? '111111' : '000000';

  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
    const r = await svc.verify({ ...issueArgs(), code: wrong });
    assert.equal(r.ok, false);
  }
  const final = await svc.verify({ ...issueArgs(), code: wrong });
  assert.equal(final.ok, false);
  if (!final.ok) assert.equal(final.reason, 'too_many_attempts');

  // Crucially: the RIGHT code no longer works either. Without this, an
  // attacker gets unlimited guesses and the real user still gets in.
  const withCorrect = await svc.verify({ ...issueArgs(), code });
  assert.equal(withCorrect.ok, false, 'challenge must be dead after the cap');
});

test('otp: an expired code is rejected', async () => {
  let now = new Date('2026-08-29T00:00:00Z');
  const db = fakeDb();
  const svc = new OtpService(db, { now: () => now });
  const { code } = await svc.issue(issueArgs());

  now = new Date(now.getTime() + CODE_TTL_MS + 1000);
  const r = await svc.verify({ ...issueArgs(), code });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'expired');
});

test('otp: SECURITY — requesting a new code invalidates the previous one', async () => {
  const db = fakeDb();
  const svc = new OtpService(db);
  const first = await svc.issue(issueArgs());
  const second = await svc.issue(issueArgs());

  // Only one live code at a time: no accumulating parallel guesses.
  assert.equal((await svc.verify({ ...issueArgs(), code: first.code })).ok, false);
  assert.equal((await svc.verify({ ...issueArgs(), code: second.code })).ok, true);
});

test('otp: a code for one purpose does not verify another', async () => {
  const db = fakeDb();
  const svc = new OtpService(db);
  const { code } = await svc.issue(issueArgs({ purpose: 'verify_email' }));
  const r = await svc.verify({ ...issueArgs({ purpose: 'password_reset' }), code });
  assert.equal(r.ok, false);
});

test('otp: verification is case-insensitive on the email identifier', async () => {
  const db = fakeDb();
  const svc = new OtpService(db);
  const { code } = await svc.issue(issueArgs({ identifier: 'Owner@Example.com' }));
  const r = await svc.verify({ ...issueArgs({ identifier: 'OWNER@EXAMPLE.COM' }), code });
  assert.equal(r.ok, true);
});

test('otp: an unknown identifier reports not_found rather than throwing', async () => {
  const svc = new OtpService(fakeDb());
  const r = await svc.verify({ ...issueArgs({ identifier: 'nobody@example.com' }), code: '123456' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'not_found');
});

// ── flows ───────────────────────────────────────────────────────────────────
function fakeNotify(sent: Array<Record<string, unknown>>) {
  return {
    async send(input: Record<string, unknown>) {
      sent.push(input);
      return { status: 'sent' as const, deliveryId: 'd1', providerMessageId: 'm1' };
    },
  } as never;
}
const fakeAuth = (revoked: string[]) =>
  ({ async revokeAllSessions(userId: string) { revoked.push(userId); } }) as never;

function flowsFor(db: ReturnType<typeof fakeDb>, sent: Array<Record<string, unknown>>, revoked: string[] = []) {
  return new OtpFlows({ db, otp: new OtpService(db), notify: fakeNotify(sent), auth: fakeAuth(revoked) });
}

test('flow: email verification sends a code and marks the address verified', async () => {
  const db = fakeDb();
  db.users.push({ id: 'u1', email: EMAIL, email_verified_at: null });
  const sent: Array<Record<string, unknown>> = [];
  const flows = flowsFor(db, sent);

  const out = await flows.requestEmailVerification('u1');
  assert.equal(out.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!['category'], 'transactional');

  const code = String((sent[0]!['vars'] as Record<string, unknown>)['code']);
  await flows.confirmEmailVerification('u1', code);
  assert.ok(db.users[0]!['email_verified_at'], 'address should now be verified');
});

test('flow: an already-verified address is not re-sent', async () => {
  const db = fakeDb();
  db.users.push({ id: 'u1', email: EMAIL, email_verified_at: new Date() });
  const sent: Array<Record<string, unknown>> = [];
  const out = await flowsFor(db, sent).requestEmailVerification('u1');
  assert.equal(out.sent, false);
  assert.equal(sent.length, 0);
});

test('flow: a wrong verification code does not verify the address', async () => {
  const db = fakeDb();
  db.users.push({ id: 'u1', email: EMAIL, email_verified_at: null });
  const sent: Array<Record<string, unknown>> = [];
  const flows = flowsFor(db, sent);
  await flows.requestEmailVerification('u1');

  await assert.rejects(() => flows.confirmEmailVerification('u1', '000000'), AppError);
  assert.equal(db.users[0]!['email_verified_at'], null);
});

test('flow: SECURITY — password reset does not reveal whether an account exists', async () => {
  const db = fakeDb();
  db.users.push({ id: 'u1', email: EMAIL, status: 'active' });
  const sent: Array<Record<string, unknown>> = [];
  const flows = flowsFor(db, sent);

  const known = await flows.requestPasswordReset(EMAIL);
  const unknown = await flows.requestPasswordReset('nobody@example.com');

  assert.deepEqual(known, unknown, 'both responses must be identical');
  assert.equal(known.message, REQUEST_ACK);
  assert.equal(sent.length, 1, 'only the real account gets an email');
});

test('flow: a suspended account gets no reset code, but the same response', async () => {
  const db = fakeDb();
  db.users.push({ id: 'u1', email: EMAIL, status: 'suspended' });
  const sent: Array<Record<string, unknown>> = [];
  const out = await flowsFor(db, sent).requestPasswordReset(EMAIL);
  assert.equal(out.message, REQUEST_ACK);
  assert.equal(sent.length, 0);
});

test('flow: SECURITY — a completed reset revokes every session', async () => {
  const db = fakeDb();
  db.users.push({ id: 'u1', email: EMAIL, status: 'active' });
  const sent: Array<Record<string, unknown>> = [];
  const revoked: string[] = [];
  const flows = flowsFor(db, sent, revoked);

  await flows.requestPasswordReset(EMAIL);
  const code = String((sent[0]!['vars'] as Record<string, unknown>)['code']);
  await flows.confirmPasswordReset({ email: EMAIL, code, newPassword: 'a-long-enough-password' });

  assert.deepEqual(revoked, ['u1'], 'an attacker session must not survive the reset');
  assert.ok(String(db.users[0]!['password_hash']).startsWith('scrypt$'));
});

test('flow: a weak new password is refused before the code is spent', async () => {
  const db = fakeDb();
  db.users.push({ id: 'u1', email: EMAIL, status: 'active' });
  const sent: Array<Record<string, unknown>> = [];
  const flows = flowsFor(db, sent);
  await flows.requestPasswordReset(EMAIL);
  const code = String((sent[0]!['vars'] as Record<string, unknown>)['code']);

  await assert.rejects(
    () => flows.confirmPasswordReset({ email: EMAIL, code, newPassword: 'short' }),
    (e: unknown) => e instanceof AppError && e.status === 400,
  );
  // The code survives, so the user can retry with a better password.
  await flows.confirmPasswordReset({ email: EMAIL, code, newPassword: 'a-long-enough-password' });
});

test('flow: a wrong reset code leaves the password unchanged', async () => {
  const db = fakeDb();
  db.users.push({ id: 'u1', email: EMAIL, status: 'active', password_hash: 'original' });
  const sent: Array<Record<string, unknown>> = [];
  const revoked: string[] = [];
  const flows = flowsFor(db, sent, revoked);
  await flows.requestPasswordReset(EMAIL);

  await assert.rejects(
    () => flows.confirmPasswordReset({ email: EMAIL, code: '000000', newPassword: 'a-long-enough-password' }),
    AppError,
  );
  assert.equal(db.users[0]!['password_hash'], 'original');
  assert.deepEqual(revoked, []);
});

test('flow: the reset email is transactional, so it needs no consent', async () => {
  const db = fakeDb();
  db.users.push({ id: 'u1', email: EMAIL, status: 'active' });
  const sent: Array<Record<string, unknown>> = [];
  await flowsFor(db, sent).requestPasswordReset(EMAIL);
  assert.equal(sent[0]!['category'], 'transactional');
});

test('flow: each issued code gets its own idempotency key', async () => {
  const db = fakeDb();
  db.users.push({ id: 'u1', email: EMAIL, status: 'active' });
  const sent: Array<Record<string, unknown>> = [];
  const flows = flowsFor(db, sent);
  await flows.requestPasswordReset(EMAIL);
  await flows.requestPasswordReset(EMAIL);
  assert.notEqual(sent[0]!['idempotencyKey'], sent[1]!['idempotencyKey']);
});
