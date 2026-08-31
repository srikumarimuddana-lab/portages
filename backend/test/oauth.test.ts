/**
 * OAuth security tests.
 *
 * These are written as attacks. The account-linking suite in particular
 * encodes the takeover scenario that OAuth implementations get wrong:
 * an attacker registering a victim's email at a provider that never
 * verified it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';

import { verifyIdToken, isEmailVerified, JwtError, JwksCache, type Jwk } from '../src/lib/jwt.js';
import {
  createAuthRequest,
  s256,
  verifierMatches,
  safeRedirectPath,
  buildAuthorizeUrl,
  AUTH_REQUEST_TTL_MS,
} from '../src/modules/auth/oauth/pkce.js';
import { decideLink, explainBlock, type LinkContext } from '../src/modules/auth/oauth/linking.js';
import { providerFor, GOOGLE, FACEBOOK } from '../src/modules/auth/oauth/providers.js';

// ── test key material ───────────────────────────────────────────────────────
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attackerRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = 'portage-client-id.apps.googleusercontent.com';

function jwkFor(key: KeyObject, kid: string): Jwk {
  return { ...(key.export({ format: 'jwk' }) as object), kid, alg: 'RS256', use: 'sig' } as Jwk;
}
const JWKS: Jwk[] = [jwkFor(rsa.publicKey, 'key-1')];

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
}

function signToken(
  claims: Record<string, unknown>,
  opts: { key?: KeyObject; alg?: string; kid?: string } = {},
): string {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'key-1', typ: 'JWT' };
  const input = `${b64(header)}.${b64(claims)}`;
  const sig = createSign('SHA256').update(input).sign(opts.key ?? rsa.privateKey);
  return `${input}.${sig.toString('base64url')}`;
}

const now = 1_800_000_000;
function validClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: 'google-subject-123',
    aud: AUDIENCE,
    iat: now - 10,
    exp: now + 3600,
    email: 'owner@example.com',
    email_verified: true,
    ...over,
  };
}
const baseOpts = { issuer: ISSUER, audience: AUDIENCE, now };

// ── id_token verification ───────────────────────────────────────────────────
test('jwt: a well-formed token from the provider verifies', () => {
  const claims = verifyIdToken(signToken(validClaims()), JWKS, baseOpts);
  assert.equal(claims.sub, 'google-subject-123');
  assert.equal(claims.email, 'owner@example.com');
});

test('jwt: token signed by the wrong key is rejected', () => {
  const forged = signToken(validClaims(), { key: attackerRsa.privateKey });
  assert.throws(() => verifyIdToken(forged, JWKS, baseOpts), JwtError);
});

test('jwt: alg=none is rejected', () => {
  const header = b64({ alg: 'none', kid: 'key-1', typ: 'JWT' });
  const token = `${header}.${b64(validClaims())}.`;
  assert.throws(() => verifyIdToken(token, JWKS, baseOpts), /unsupported algorithm/);
});

test('jwt: HS256 algorithm-confusion attempt is rejected', () => {
  // Classic attack: sign with HMAC using the RSA public key as the secret.
  const header = b64({ alg: 'HS256', kid: 'key-1', typ: 'JWT' });
  const token = `${header}.${b64(validClaims())}.ZmFrZS1zaWduYXR1cmU`;
  assert.throws(() => verifyIdToken(token, JWKS, baseOpts), /unsupported algorithm/);
});

test('jwt: token addressed to a different application is rejected', () => {
  const other = signToken(validClaims({ aud: 'someone-elses-client-id' }));
  assert.throws(() => verifyIdToken(other, JWKS, baseOpts), /audience mismatch/);
});

test('jwt: wrong issuer is rejected', () => {
  const t = signToken(validClaims({ iss: 'https://evil.example' }));
  assert.throws(() => verifyIdToken(t, JWKS, baseOpts), /issuer mismatch/);
});

test('jwt: expired token is rejected', () => {
  const t = signToken(validClaims({ exp: now - 3600 }));
  assert.throws(() => verifyIdToken(t, JWKS, baseOpts), /expired/);
});

test('jwt: token issued in the future is rejected', () => {
  const t = signToken(validClaims({ iat: now + 3600 }));
  assert.throws(() => verifyIdToken(t, JWKS, baseOpts), /future/);
});

test('jwt: nonce mismatch is rejected (replay guard)', () => {
  const t = signToken(validClaims({ nonce: 'nonce-from-another-login' }));
  assert.throws(
    () => verifyIdToken(t, JWKS, { ...baseOpts, nonce: 'our-nonce' }),
    /nonce mismatch/,
  );
});

test('jwt: matching nonce accepted', () => {
  const t = signToken(validClaims({ nonce: 'our-nonce' }));
  const c = verifyIdToken(t, JWKS, { ...baseOpts, nonce: 'our-nonce' });
  assert.equal(c.nonce, 'our-nonce');
});

test('jwt: missing nonce rejected when one was requested', () => {
  const t = signToken(validClaims());
  assert.throws(() => verifyIdToken(t, JWKS, { ...baseOpts, nonce: 'our-nonce' }), /nonce/);
});

test('jwt: unknown kid is rejected', () => {
  const t = signToken(validClaims(), { kid: 'rotated-away' });
  assert.throws(() => verifyIdToken(t, JWKS, baseOpts), /no matching key/);
});

test('jwt: malformed tokens are rejected without throwing raw errors', () => {
  for (const bad of ['', 'a', 'a.b', 'a.b.c.d', 'not.a.jwt']) {
    assert.throws(() => verifyIdToken(bad, JWKS, baseOpts), JwtError);
  }
});

test('jwt: token missing a subject is rejected', () => {
  const t = signToken(validClaims({ sub: undefined }));
  assert.throws(() => verifyIdToken(t, JWKS, baseOpts), /subject/);
});

test('jwt: email_verified only counts as true for true or "true"', () => {
  assert.equal(isEmailVerified({ email_verified: true } as never), true);
  assert.equal(isEmailVerified({ email_verified: 'true' } as never), true);
  assert.equal(isEmailVerified({ email_verified: false } as never), false);
  assert.equal(isEmailVerified({ email_verified: 'false' } as never), false);
  assert.equal(isEmailVerified({ email_verified: 1 } as never), false);
  assert.equal(isEmailVerified({} as never), false);
});

// ── JWKS cache ──────────────────────────────────────────────────────────────
test('jwks: caches within the TTL and refetches for an unknown kid', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ keys: JWKS }) };
  }) as unknown as typeof fetch;

  const cache = new JwksCache('https://example/jwks', { ttlMs: 60_000, fetchImpl });
  await cache.get('key-1');
  await cache.get('key-1');
  assert.equal(calls, 1, 'second lookup should be served from cache');

  // An unknown kid means the provider rotated: refetch even though fresh.
  await cache.get('key-2');
  assert.equal(calls, 2);
});

test('jwks: a failed fetch surfaces as an error, not an empty key set', async () => {
  const fetchImpl = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
  const cache = new JwksCache('https://example/jwks', { fetchImpl });
  await assert.rejects(() => cache.get(), /JWKS fetch failed: 503/);
});

// ── PKCE ────────────────────────────────────────────────────────────────────
test('pkce: challenge is the S256 of the verifier', () => {
  const m = createAuthRequest();
  assert.equal(m.codeChallenge, s256(m.codeVerifier));
  assert.equal(verifierMatches(m.codeVerifier, m.codeChallenge), true);
});

test('pkce: a different verifier does not match the challenge', () => {
  const a = createAuthRequest();
  const b = createAuthRequest();
  assert.equal(verifierMatches(b.codeVerifier, a.codeChallenge), false);
});

test('pkce: state, verifier and nonce are three distinct random values', () => {
  const m = createAuthRequest();
  assert.notEqual(m.state, m.codeVerifier);
  assert.notEqual(m.state, m.nonce);
  assert.notEqual(m.codeVerifier, m.nonce);
  const other = createAuthRequest();
  assert.notEqual(m.state, other.state);
});

test('pkce: raw verifier and nonce are never what gets stored', () => {
  const m = createAuthRequest();
  assert.ok(!m.codeChallengeHash.toString('hex').includes(m.codeVerifier));
  assert.ok(!m.nonceHash.toString('hex').includes(m.nonce));
  assert.equal(m.nonceHash.length, 32);
});

test('pkce: authorization requests expire', () => {
  const t = new Date('2026-01-01T00:00:00Z');
  const m = createAuthRequest(t);
  assert.equal(m.expiresAt.getTime(), t.getTime() + AUTH_REQUEST_TTL_MS);
});

test('pkce: authorize URL carries S256 and all request parameters', () => {
  const m = createAuthRequest();
  const url = buildAuthorizeUrl({
    authorizeUrl: GOOGLE.authorizeUrl,
    clientId: 'cid',
    redirectUri: 'https://portage.ca/api/auth/oauth/google/callback',
    scope: GOOGLE.scope,
    state: m.state,
    codeChallenge: m.codeChallenge,
    nonce: m.nonce,
  });
  assert.ok(url.includes('code_challenge_method=S256'));
  assert.ok(url.includes('response_type=code'));
  assert.ok(url.includes(`state=${encodeURIComponent(m.state)}`));
  // The verifier must never appear in a URL the browser can see.
  assert.ok(!url.includes(m.codeVerifier));
});

// ── open redirect ───────────────────────────────────────────────────────────
test('redirect: relative paths are preserved', () => {
  assert.equal(safeRedirectPath('/listings/regina'), '/listings/regina');
  assert.equal(safeRedirectPath('/dashboard?tab=saved'), '/dashboard?tab=saved');
});

test('redirect: off-site targets fall back to the default', () => {
  for (const evil of [
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'http://evil.example',
    'javascript:alert(1)',
    '/redirect?to=https://evil.example/x://y',
  ]) {
    const out = safeRedirectPath(evil);
    assert.ok(out === '/' || out.startsWith('/'), `${evil} produced ${out}`);
    assert.ok(!out.includes('evil.example') || !out.includes('://'), `open redirect via ${evil}`);
  }
  assert.equal(safeRedirectPath('//evil.example'), '/');
  assert.equal(safeRedirectPath('https://evil.example'), '/');
});

test('redirect: empty, oversized and control-character input falls back', () => {
  assert.equal(safeRedirectPath(null), '/');
  assert.equal(safeRedirectPath(''), '/');
  assert.equal(safeRedirectPath('/' + 'a'.repeat(600)), '/');
  assert.equal(safeRedirectPath('/path\nwith-newline'), '/');
});

// ── account linking: the takeover suite ─────────────────────────────────────
const verifiedProvider = {
  provider: 'google',
  providerUserId: 'sub-1',
  email: 'victim@example.com',
  emailVerified: true,
};
const unverifiedProvider = { ...verifiedProvider, emailVerified: false };

function ctx(over: Partial<LinkContext> = {}): LinkContext {
  return {
    identity: verifiedProvider,
    existingLink: null,
    emailMatch: null,
    ...over,
  };
}

test('link: ATTACK — unverified provider email cannot auto-link to an existing account', () => {
  const d = decideLink(ctx({
    identity: unverifiedProvider,
    emailMatch: { userId: 'victim-user', status: 'active', emailVerified: true },
  }));
  assert.equal(d.action, 'require_proof');
  if (d.action === 'require_proof') assert.equal(d.reason, 'provider_email_unverified');
});

test('link: ATTACK — unverified LOCAL account cannot be claimed via a verified provider', () => {
  // The mirror image: attacker pre-registers a local account under the
  // victim's address without verifying it, hoping the real owner's verified
  // provider login hands it over.
  const d = decideLink(ctx({
    emailMatch: { userId: 'squatted-user', status: 'active', emailVerified: false },
  }));
  assert.equal(d.action, 'require_proof');
  if (d.action === 'require_proof') assert.equal(d.reason, 'local_email_unverified');
});

test('link: both sides verified is the only automatic link', () => {
  const d = decideLink(ctx({
    emailMatch: { userId: 'owner-user', status: 'active', emailVerified: true },
  }));
  assert.deepEqual(d, { action: 'link_to_existing', userId: 'owner-user' });
});

test('link: an already-bound provider account signs in without consulting email', () => {
  const d = decideLink(ctx({
    identity: { ...unverifiedProvider, email: 'changed@elsewhere.com' },
    existingLink: { userId: 'bound-user' },
    emailMatch: { userId: 'someone-else', status: 'active', emailVerified: true },
  }));
  assert.deepEqual(d, { action: 'sign_in', userId: 'bound-user' });
});

test('link: ATTACK — cannot steal a provider account already bound elsewhere', () => {
  const d = decideLink(ctx({
    existingLink: { userId: 'other-user' },
    signedInUserId: 'attacker-user',
  }));
  assert.equal(d.action, 'reject');
  if (d.action === 'reject') assert.equal(d.reason, 'already_linked_to_other_user');
});

test('link: a signed-in user may link deliberately', () => {
  const d = decideLink(ctx({ identity: unverifiedProvider, signedInUserId: 'me' }));
  assert.deepEqual(d, { action: 'link_to_existing', userId: 'me' });
});

test('link: new user with a verified provider email creates an account', () => {
  assert.deepEqual(decideLink(ctx()), { action: 'create_account' });
});

test('link: new user with an UNVERIFIED provider email is refused', () => {
  const d = decideLink(ctx({ identity: unverifiedProvider }));
  assert.equal(d.action, 'reject');
  if (d.action === 'reject') assert.equal(d.reason, 'provider_email_unverified');
});

test('link: provider that supplies no email creates a fresh account', () => {
  const d = decideLink(ctx({ identity: { ...verifiedProvider, email: null } }));
  assert.deepEqual(d, { action: 'create_account' });
});

test('link: no provider email plus an email match requires proof, never a guess', () => {
  const d = decideLink(ctx({
    identity: { ...verifiedProvider, email: null },
    emailMatch: { userId: 'someone', status: 'active', emailVerified: true },
  }));
  assert.equal(d.action, 'require_proof');
});

test('link: suspended accounts are refused', () => {
  const d = decideLink(ctx({
    emailMatch: { userId: 'suspended-user', status: 'suspended', emailVerified: true },
  }));
  assert.equal(d.action, 'reject');
  if (d.action === 'reject') assert.equal(d.reason, 'account_suspended');
});

test('link: every block reason has a user-facing explanation', () => {
  for (const r of [
    'provider_email_unverified',
    'local_email_unverified',
    'account_suspended',
    'provider_supplied_no_email',
    'already_linked_to_other_user',
  ] as const) {
    const msg = explainBlock(r);
    assert.ok(msg.length > 20);
    // Never leak internals to the user.
    assert.ok(!msg.includes('_'));
  }
});

// ── provider config ─────────────────────────────────────────────────────────
test('providers: known providers resolve, unknown ones throw', () => {
  assert.equal(providerFor('google').id, 'google');
  assert.equal(providerFor('facebook').id, 'facebook');
  assert.throws(() => providerFor('evil-idp'), /unknown oauth provider/);
});

test('providers: all endpoints are https', () => {
  for (const p of [GOOGLE, FACEBOOK]) {
    for (const url of [p.authorizeUrl, p.tokenUrl, p.jwksUrl]) {
      assert.ok(url.startsWith('https://'), `${p.id}: ${url} must be https`);
    }
  }
});

test('providers: google requests openid scope', () => {
  assert.ok(GOOGLE.scope.includes('openid'));
});
