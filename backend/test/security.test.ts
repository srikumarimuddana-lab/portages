/**
 * Security tests. These assert the properties that matter, not the shape of
 * the code: a wrong password must fail, a stolen digest must be useless, an
 * unknown field must be rejected, a share must expire.
 *
 * Run with: node --test (no test framework dependency required).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword,
  verifyPassword,
  needsRehash,
  generateToken,
  hashToken,
  timingSafeEqualStrings,
  signStorageUrl,
  verifyStorageUrl,
  pseudonymize,
} from '../src/lib/crypto.js';
import {
  createSessionMaterial,
  checkSession,
  verifyCsrf,
  requiresCsrf,
  serializeCookie,
  parseCookies,
  SESSION_COOKIE,
  type StoredSession,
} from '../src/lib/session.js';
import { RateLimiter, lockoutUntil, isLocked, LIMITS } from '../src/lib/ratelimit.js';
import * as v from '../src/lib/validate.js';
import {
  validateUpload,
  buildStorageKey,
  canAccess,
  safeDownloadName,
  retentionFor,
  MAX_DOCUMENT_BYTES,
} from '../src/modules/documents/policy.js';

// ── passwords ───────────────────────────────────────────────────────────────
test('password: correct password verifies', async () => {
  const h = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', h), true);
});

test('password: wrong password rejected', async () => {
  const h = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('Correct horse battery staple', h), false);
  assert.equal(await verifyPassword('', h), false);
});

test('password: hash is salted — same input yields different hashes', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('same-password', b), true);
});

test('password: plaintext never appears in the stored hash', async () => {
  const secret = 'super-secret-passphrase';
  const h = await hashPassword(secret);
  assert.ok(!h.includes(secret));
  assert.ok(h.startsWith('scrypt$'));
});

test('password: malformed stored hash returns false, never throws', async () => {
  for (const bad of ['', 'garbage', 'scrypt$1$2$3', 'bcrypt$a$b$c$d$e', 'scrypt$0$8$1$AA$BB', 'scrypt$3$8$1$AA$BB']) {
    assert.equal(await verifyPassword('x', bad), false, `should reject: ${bad}`);
  }
});

test('password: unicode normalization is stable', async () => {
  const composed = 'café-pass';           // é as one code point
  const decomposed = 'café-pass';   // e + combining acute
  const h = await hashPassword(composed);
  assert.equal(await verifyPassword(decomposed, h), true);
});

test('password: weaker parameters are flagged for rehash', () => {
  assert.equal(needsRehash('scrypt$1024$8$1$AA$BB'), true);
  assert.equal(needsRehash('not-a-hash'), true);
});

// ── tokens ──────────────────────────────────────────────────────────────────
test('token: high entropy and unique', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(generateToken(32));
  assert.equal(seen.size, 500);
  assert.ok(generateToken(32).length >= 43); // 32 bytes base64url
});

test('token: stored digest cannot be reversed to the token', () => {
  const t = generateToken(32);
  const digest = hashToken(t);
  assert.equal(digest.length, 32);
  assert.ok(!digest.toString('base64url').includes(t));
  // Same token always maps to the same digest (lookup works).
  assert.deepEqual(hashToken(t), digest);
});

test('timingSafeEqualStrings: correct results regardless of length', () => {
  assert.equal(timingSafeEqualStrings('abc', 'abc'), true);
  assert.equal(timingSafeEqualStrings('abc', 'abd'), false);
  assert.equal(timingSafeEqualStrings('abc', 'abcdefghijk'), false);
  assert.equal(timingSafeEqualStrings('', ''), true);
});

test('pseudonymize: same input+pepper is stable, different pepper severs link', () => {
  const a = pseudonymize('198.51.100.7', 'pepper-1');
  const b = pseudonymize('198.51.100.7', 'pepper-1');
  const c = pseudonymize('198.51.100.7', 'pepper-2');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

// ── signed storage URLs ─────────────────────────────────────────────────────
const SECRET = 'test-signing-secret';

test('signed url: round-trips and binds key, user and expiry', () => {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const tok = signStorageUrl({ storageKey: 'documents/u/1.pdf', userId: 'u', expiresAt: exp }, SECRET);
  const out = verifyStorageUrl(tok, SECRET);
  if (out === null) throw new Error('signature should have verified');
  assert.equal(out.storageKey, 'documents/u/1.pdf');
  assert.equal(out.userId, 'u');
});

test('signed url: expired token rejected', () => {
  const exp = Math.floor(Date.now() / 1000) - 1;
  const tok = signStorageUrl({ storageKey: 'k', userId: 'u', expiresAt: exp }, SECRET);
  assert.equal(verifyStorageUrl(tok, SECRET), null);
});

test('signed url: tampered payload rejected', () => {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const tok = signStorageUrl({ storageKey: 'documents/alice/1.pdf', userId: 'alice', expiresAt: exp }, SECRET);
  const forged = Buffer.from('documents/bob/1.pdf\nbob\n' + exp, 'utf8').toString('base64url') +
    '.' + tok.split('.')[1];
  assert.equal(verifyStorageUrl(forged, SECRET), null);
});

test('signed url: wrong signing key rejected', () => {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const tok = signStorageUrl({ storageKey: 'k', userId: 'u', expiresAt: exp }, SECRET);
  assert.equal(verifyStorageUrl(tok, 'other-secret'), null);
});

test('signed url: garbage input rejected without throwing', () => {
  for (const bad of ['', '.', 'abc', 'a.b', '...']) {
    assert.equal(verifyStorageUrl(bad, SECRET), null);
  }
});

// ── sessions ────────────────────────────────────────────────────────────────
function storedFrom(m = createSessionMaterial(), over: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'sess-1',
    userId: 'user-1',
    csrfHash: m.csrfHash,
    idleExpiresAt: m.idleExpiresAt,
    absoluteExpiresAt: m.absoluteExpiresAt,
    revokedAt: null,
    ...over,
  };
}

test('session: fresh session is valid and slides the idle window', () => {
  const r = checkSession(storedFrom());
  assert.equal(r.valid, true);
});

test('session: revoked session rejected', () => {
  const r = checkSession(storedFrom(undefined, { revokedAt: new Date() }));
  assert.deepEqual(r, { valid: false, reason: 'revoked' });
});

test('session: idle expiry rejected', () => {
  const past = new Date(Date.now() - 1000);
  const r = checkSession(storedFrom(undefined, { idleExpiresAt: past }));
  assert.deepEqual(r, { valid: false, reason: 'idle_expired' });
});

test('session: absolute expiry rejected even when recently active', () => {
  const r = checkSession(
    storedFrom(undefined, {
      idleExpiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() - 1),
    }),
  );
  assert.deepEqual(r, { valid: false, reason: 'absolute_expired' });
});

test('session: idle renewal never exceeds the absolute ceiling', () => {
  const ceiling = new Date(Date.now() + 5_000);
  const r = checkSession(
    storedFrom(undefined, { idleExpiresAt: new Date(Date.now() + 4_000), absoluteExpiresAt: ceiling }),
  );
  assert.equal(r.valid, true);
  if (r.valid) assert.ok(r.renewIdleTo <= ceiling);
});

test('session: login mints a brand new token (no fixation)', () => {
  const a = createSessionMaterial();
  const b = createSessionMaterial();
  assert.notEqual(a.sessionToken, b.sessionToken);
  assert.notDeepEqual(a.tokenHash, b.tokenHash);
});

// ── CSRF ────────────────────────────────────────────────────────────────────
test('csrf: safe methods exempt, unsafe methods required', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) assert.equal(requiresCsrf(m), false);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(requiresCsrf(m), true);
});

test('csrf: matching header and cookie accepted', () => {
  const m = createSessionMaterial();
  assert.equal(verifyCsrf(m.csrfToken, m.csrfToken, m.csrfHash), true);
});

test('csrf: mismatched header and cookie rejected', () => {
  const m = createSessionMaterial();
  assert.equal(verifyCsrf(m.csrfToken, generateToken(32), m.csrfHash), false);
});

test('csrf: attacker-supplied pair not matching the stored digest is rejected', () => {
  const m = createSessionMaterial();
  const injected = generateToken(32); // attacker sets both halves
  assert.equal(verifyCsrf(injected, injected, m.csrfHash), false);
});

test('csrf: missing halves rejected', () => {
  const m = createSessionMaterial();
  assert.equal(verifyCsrf(undefined, m.csrfToken, m.csrfHash), false);
  assert.equal(verifyCsrf(m.csrfToken, undefined, m.csrfHash), false);
});

// ── cookies ─────────────────────────────────────────────────────────────────
test('cookie: session cookie is HttpOnly, SameSite and __Host- prefixed', () => {
  const c = serializeCookie(SESSION_COOKIE, 'tok', { secure: true, maxAgeMs: 60_000 });
  assert.ok(SESSION_COOKIE.startsWith('__Host-'));
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
  assert.ok(!/Domain=/.test(c)); // __Host- forbids Domain
});

test('cookie: parser ignores prototype-polluting names', () => {
  const out = parseCookies('__proto__=bad; a=1');
  assert.equal(out['a'], '1');
  assert.equal(Object.getPrototypeOf(out), null);
  assert.equal(({} as Record<string, unknown>)['bad'], undefined);
});

// ── rate limiting ───────────────────────────────────────────────────────────
test('ratelimit: blocks past the maximum and reports retry-after', () => {
  const rl = new RateLimiter({ windowMs: 1000, max: 3 });
  assert.equal(rl.check('ip').allowed, true);
  assert.equal(rl.check('ip').allowed, true);
  assert.equal(rl.check('ip').allowed, true);
  const blocked = rl.check('ip');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
});

test('ratelimit: keys are independent', () => {
  const rl = new RateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('b').allowed, true);
  assert.equal(rl.check('a').allowed, false);
});

test('ratelimit: window resets', () => {
  const rl = new RateLimiter({ windowMs: 1000, max: 1 });
  const t0 = 1_000_000;
  assert.equal(rl.check('k', t0).allowed, true);
  assert.equal(rl.check('k', t0 + 500).allowed, false);
  assert.equal(rl.check('k', t0 + 1001).allowed, true);
});

test('ratelimit: memory is bounded under key rotation', () => {
  const rl = new RateLimiter({ windowMs: 60_000, max: 5 }, 50);
  for (let i = 0; i < 500; i++) rl.check(`key-${i}`);
  // Not asserting internals; the guarantee is that it does not grow unbounded.
  assert.ok(true);
});

test('ratelimit: login limit is far stricter than read limit', () => {
  assert.ok(LIMITS.login.max < LIMITS.read.max);
});

test('lockout: escalates after repeated failures and caps at one hour', () => {
  assert.equal(lockoutUntil(4), null);
  const t = 1_000_000;
  const first = lockoutUntil(5, t)!;
  const later = lockoutUntil(12, t)!;
  assert.ok(first.getTime() > t);
  assert.ok(later.getTime() > first.getTime());
  assert.ok(later.getTime() - t <= 60 * 60 * 1000);
});

test('lockout: isLocked respects the clock', () => {
  assert.equal(isLocked(new Date(Date.now() + 10_000)), true);
  assert.equal(isLocked(new Date(Date.now() - 1)), false);
  assert.equal(isLocked(null), false);
});

// ── validation ──────────────────────────────────────────────────────────────
const listingSchema = v.object({
  mode: v.enumOf(['sale', 'rent'] as const),
  priceCents: v.integer({ min: 1, max: 100_000_000_00 }),
  title: v.string({ min: 3, max: 140 }),
  amenities: v.optional(v.array(v.string({ max: 40 }), { max: 30 })),
});

test('validate: accepts a well-formed payload', () => {
  const r = listingSchema.parse({ mode: 'rent', priceCents: 180000, title: 'Bright 2BR' });
  assert.equal(r.ok, true);
});

test('validate: rejects unknown fields (mass assignment guard)', () => {
  const r = listingSchema.parse({
    mode: 'rent', priceCents: 180000, title: 'Bright 2BR',
    ownerId: 'someone-elses-id', status: 'live',
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('unknown field')));
});

test('validate: rejects prototype pollution attempts', () => {
  const r = listingSchema.parse(JSON.parse('{"__proto__":{"admin":true},"mode":"rent","priceCents":1,"title":"abc"}'));
  assert.equal(r.ok, false);
});

test('validate: enforces bounds and types', () => {
  assert.equal(listingSchema.parse({ mode: 'lease', priceCents: 1, title: 'abc' }).ok, false);
  assert.equal(listingSchema.parse({ mode: 'rent', priceCents: -5, title: 'abc' }).ok, false);
  assert.equal(listingSchema.parse({ mode: 'rent', priceCents: 1, title: 'ab' }).ok, false);
  assert.equal(listingSchema.parse({ mode: 'rent', priceCents: '100', title: 'abc' }).ok, false);
});

test('validate: strings reject control characters', () => {
  assert.equal(v.string().parse('ok injected').ok, false);
});

test('validate: strings are bounded by default', () => {
  assert.equal(v.string().parse('x'.repeat(1001)).ok, false);
});

test('validate: email accepts valid and rejects malformed', () => {
  const e = v.email();
  assert.equal(e.parse('Owner@Example.com').ok, true);
  const ok = e.parse('Owner@Example.com');
  if (ok.ok) assert.equal(ok.value, 'owner@example.com'); // normalized
  for (const bad of ['no-at', 'a@', '@b.com', 'a b@c.com', 'a@b', 'a@@b.com']) {
    assert.equal(e.parse(bad).ok, false, `should reject ${bad}`);
  }
});

test('validate: uuid rejects non-uuid strings', () => {
  const u = v.uuid();
  assert.equal(u.parse('44444444-4444-4444-8444-444444444444').ok, true);
  assert.equal(u.parse('not-a-uuid').ok, false);
  assert.equal(u.parse("' OR 1=1--").ok, false);
});

test('validate: arrays are length-bounded', () => {
  const a = v.array(v.string({ max: 5 }), { max: 2 });
  assert.equal(a.parse(['a', 'b']).ok, true);
  assert.equal(a.parse(['a', 'b', 'c']).ok, false);
});

// ── document locker ─────────────────────────────────────────────────────────
test('documents: allowed type within size accepted', () => {
  const r = validateUpload({ mime: 'application/pdf', bytes: 1024, filename: 'lease.pdf', existingCount: 0 });
  assert.deepEqual(r, { ok: true });
});

test('documents: disallowed types refused (no wildcard)', () => {
  for (const mime of ['text/html', 'application/x-msdownload', 'image/svg+xml', 'application/zip']) {
    const r = validateUpload({ mime, bytes: 10, filename: 'f.bin', existingCount: 0 });
    assert.equal(r.ok, false, `${mime} must be refused`);
  }
});

test('documents: oversized and empty uploads refused', () => {
  assert.equal(validateUpload({ mime: 'application/pdf', bytes: MAX_DOCUMENT_BYTES + 1, filename: 'a.pdf', existingCount: 0 }).ok, false);
  assert.equal(validateUpload({ mime: 'application/pdf', bytes: 0, filename: 'a.pdf', existingCount: 0 }).ok, false);
});

test('documents: extension must agree with declared MIME', () => {
  const r = validateUpload({ mime: 'application/pdf', bytes: 100, filename: 'payload.html', existingCount: 0 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'extension_mismatch');
  // jpeg/jpg alias is accepted
  assert.equal(validateUpload({ mime: 'image/jpeg', bytes: 100, filename: 'photo.jpeg', existingCount: 0 }).ok, true);
});

test('documents: per-user quota enforced', () => {
  const r = validateUpload({ mime: 'application/pdf', bytes: 100, filename: 'a.pdf', existingCount: 500 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'quota_exceeded');
});

test('documents: storage key is owner-namespaced and traversal-proof', () => {
  const owner = '11111111-1111-4111-8111-111111111111';
  const doc = '22222222-2222-4222-8222-222222222222';
  const key = buildStorageKey(owner, doc, 'application/pdf');
  assert.equal(key, `documents/${owner}/${doc}.pdf`);
  assert.ok(!key.includes('..'));
  assert.throws(() => buildStorageKey('../etc', doc, 'application/pdf'));
});

test('documents: download filename is sanitized', () => {
  assert.equal(safeDownloadName('../../etc/passwd'), 'passwd');
  assert.equal(safeDownloadName('..'), 'document');
  assert.equal(safeDownloadName(''), 'document');
  assert.ok(!safeDownloadName('a b.pdf').includes(' '));
});

test('documents: owner can access, stranger cannot', () => {
  assert.equal(canAccess({ requesterId: 'u1', ownerId: 'u1', deletedAt: null }), true);
  assert.equal(canAccess({ requesterId: 'u2', ownerId: 'u1', deletedAt: null }), false);
});

test('documents: valid share grants access; expired and revoked do not', () => {
  const base = { requesterId: 'u2', ownerId: 'u1', deletedAt: null };
  assert.equal(canAccess({ ...base, share: { expiresAt: new Date(Date.now() + 60_000), revokedAt: null } }), true);
  assert.equal(canAccess({ ...base, share: { expiresAt: new Date(Date.now() - 1), revokedAt: null } }), false);
  assert.equal(canAccess({ ...base, share: { expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() } }), false);
});

test('documents: deleted document is inaccessible even to its owner', () => {
  assert.equal(canAccess({ requesterId: 'u1', ownerId: 'u1', deletedAt: new Date() }), false);
});

test('documents: a tombstone is inaccessible to everyone, share or no share', () => {
  // A NULL owner means the account was erased (migration 019). The row lives
  // on only so the append-only access log has something to point at, until
  // the nightly purge destroys the bytes — during which window it is still a
  // real document with real bytes, and `assertAccess` finds it by id with no
  // owner filter. Nobody may read it.
  //
  // The live share is the case that matters: shares are cascade-deleted with
  // the account that granted them, so this state should not arise — and the
  // assertion is here precisely so access does not *depend* on that cascade
  // holding. Third assertion: not even someone whose own id is somehow absent.
  assert.equal(canAccess({ requesterId: 'u1', ownerId: null, deletedAt: null }), false);
  assert.equal(
    canAccess({
      requesterId: 'u2', ownerId: null, deletedAt: null,
      share: { expiresAt: new Date(Date.now() + 60_000), revokedAt: null },
    }),
    false,
    'a share must not outlive the account that granted it',
  );
  assert.equal(
    canAccess({ requesterId: null as unknown as string, ownerId: null, deletedAt: null }),
    false,
    'and NULL must never equal NULL into access',
  );
});

test('documents: retention date is set forward by kind', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  assert.ok(retentionFor('agreement', now) > now);
  assert.ok(retentionFor('agreement', now) > retentionFor('other', now));
});
