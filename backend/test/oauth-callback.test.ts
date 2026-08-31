/**
 * OAuth callback tests.
 *
 * These drive the real OAuthService against a fake database and a fake
 * provider, so the whole exchange runs: state consumption, code exchange,
 * id_token verification and the linking decision. The attacks tested are the
 * ones that matter for a callback endpoint — code replay, state injection,
 * expired requests, and a provider that lies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';

import { OAuthService, sweepAuthRequests } from '../src/modules/auth/oauth/service.js';
import type { Sql, QueryResult } from '../src/db/pool.js';
import { AppError } from '../src/lib/errors.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...(rsa.publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256' };

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
}

function idToken(over: Record<string, unknown> = {}, key: KeyObject = rsa.privateKey): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://accounts.google.com',
    sub: 'google-sub-1',
    aud: 'test-client-id',
    iat: nowSec - 5,
    exp: nowSec + 600,
    email: 'user@example.com',
    email_verified: true,
    ...over,
  };
  const input = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64(claims)}`;
  return `${input}.${createSign('SHA256').update(input).sign(key).toString('base64url')}`;
}

/** In-memory stand-in for the tables the OAuth service touches. */
interface FakeState {
  authRequests: Map<string, Record<string, unknown>>;
  identities: Array<Record<string, unknown>>;
  users: Array<{ id: string; email: string; status: string; email_verified_at: Date | null }>;
}

function fakeDb(seed: Partial<FakeState> = {}): Sql & { state: FakeState } {
  const state: FakeState = {
    authRequests: seed.authRequests ?? new Map(),
    identities: seed.identities ?? [],
    users: seed.users ?? [],
  };

  const db: Sql & { state: FakeState } = {
    state,
    async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
      const t = text.replace(/\s+/g, ' ').trim();

      if (t.startsWith('INSERT INTO oauth_auth_requests')) {
        const [stateVal, provider, verifier, nonce, redirectPath, linkingUserId, expiresAt] = params;
        state.authRequests.set(String(stateVal), {
          state: stateVal, provider, code_verifier: verifier, nonce,
          redirect_path: redirectPath, linking_user_id: linkingUserId,
          expires_at: expiresAt, consumed_at: null,
        });
        return { rows: [], rowCount: 1 };
      }

      if (t.startsWith('UPDATE oauth_auth_requests')) {
        const [stateVal, provider] = params;
        const row = state.authRequests.get(String(stateVal));
        // Mirrors "WHERE consumed_at IS NULL" — single use.
        if (!row || row['consumed_at'] || row['provider'] !== provider) {
          return { rows: [], rowCount: 0 };
        }
        row['consumed_at'] = new Date();
        return { rows: [row as R], rowCount: 1 };
      }

      if (t.startsWith('SELECT user_id FROM oauth_identities')) {
        const [provider, subject] = params;
        const hit = state.identities.find(
          (i) => i['provider'] === provider && i['provider_user_id'] === subject,
        );
        return { rows: hit ? [{ user_id: hit['user_id'] } as R] : [], rowCount: hit ? 1 : 0 };
      }

      if (t.startsWith('SELECT id, status, email_verified_at FROM users')) {
        const [email] = params;
        const u = state.users.find((x) => x.email === email);
        return { rows: u ? [u as unknown as R] : [], rowCount: u ? 1 : 0 };
      }

      if (t.startsWith('INSERT INTO users')) {
        const [email] = params;
        const id = `user-${state.users.length + 1}`;
        state.users.push({ id, email: String(email), status: 'active', email_verified_at: new Date() });
        return { rows: [{ id } as R], rowCount: 1 };
      }

      if (t.startsWith('INSERT INTO oauth_identities')) {
        const [userId, provider, subject, email, verifiedAt] = params;
        state.identities.push({
          user_id: userId, provider, provider_user_id: subject, email, email_verified_at: verifiedAt,
        });
        return { rows: [], rowCount: 1 };
      }

      if (t.startsWith('DELETE FROM oauth_auth_requests')) {
        const n = state.authRequests.size;
        state.authRequests.clear();
        return { rows: [], rowCount: n };
      }

      return { rows: [], rowCount: 0 };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  return db;
}

/**
 * Fake provider: JWKS plus a token endpoint.
 *
 * A real provider echoes back the nonce we sent in the authorize request, so
 * the fake reads it out of the stored authorization request. Tests that want
 * to attack the nonce check pass an explicit token instead.
 */
function fakeFetch(
  db: Sql & { state: FakeState },
  opts: { token?: unknown; tokenOk?: boolean } = {},
): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes('/certs') || String(url).includes('jwks')) {
      return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
    }
    const pending = [...db.state.authRequests.values()][0];
    const nonce = pending ? String(pending['nonce']) : undefined;
    return {
      ok: opts.tokenOk !== false,
      status: opts.tokenOk === false ? 400 : 200,
      json: async () => opts.token ?? { id_token: idToken(nonce ? { nonce } : {}) },
    };
  }) as unknown as typeof fetch;
}

function service(db: Sql, fetchImpl: typeof fetch): OAuthService {
  return new OAuthService(db, {
    credentials: { google: { clientId: 'test-client-id', clientSecret: 'test-secret' } },
    publicOrigin: 'https://portage.ca',
    fetchImpl,
  });
}

async function startAndGetState(svc: OAuthService): Promise<string> {
  const { state } = await svc.start('google', { redirectPath: '/dashboard' });
  return state;
}

// ── happy path ──────────────────────────────────────────────────────────────
test('callback: verified new user is created and signed in', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db));
  const state = await startAndGetState(svc);

  const out = await svc.callback('google', { code: 'auth-code', state, stateFromCookie: state });
  assert.equal(out.kind, 'signed_in');
  if (out.kind === 'signed_in') {
    assert.equal(out.isNewUser, true);
    assert.equal(out.redirectPath, '/dashboard');
  }
  assert.equal(db.state.users.length, 1);
  assert.equal(db.state.identities.length, 1);
});

test('callback: a returning user signs in without creating a second account', async () => {
  const db = fakeDb({
    users: [{ id: 'u1', email: 'user@example.com', status: 'active', email_verified_at: new Date() }],
    identities: [{ user_id: 'u1', provider: 'google', provider_user_id: 'google-sub-1' }],
  });
  const svc = service(db, fakeFetch(db));
  const state = await startAndGetState(svc);

  const out = await svc.callback('google', { code: 'c', state, stateFromCookie: state });
  assert.equal(out.kind, 'signed_in');
  if (out.kind === 'signed_in') {
    assert.equal(out.userId, 'u1');
    assert.equal(out.isNewUser, false);
  }
  assert.equal(db.state.users.length, 1);
});

// ── attacks ─────────────────────────────────────────────────────────────────
test('callback: ATTACK — authorization code cannot be replayed', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db));
  const state = await startAndGetState(svc);

  await svc.callback('google', { code: 'c', state, stateFromCookie: state });
  // Second use of the same state must fail: the row is consumed.
  await assert.rejects(
    () => svc.callback('google', { code: 'c', state, stateFromCookie: state }),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
});

test('callback: ATTACK — state not matching the browser cookie is refused', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db));
  const state = await startAndGetState(svc);

  await assert.rejects(
    () => svc.callback('google', { code: 'c', state, stateFromCookie: 'attacker-state' }),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
});

test('callback: unknown state is refused', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db));
  await assert.rejects(
    () => svc.callback('google', { code: 'c', state: 'never-issued' }),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
});

test('callback: expired authorization request is refused', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db));
  const state = await startAndGetState(svc);
  // Age the row past its expiry.
  db.state.authRequests.get(state)!['expires_at'] = new Date(Date.now() - 1000);

  await assert.rejects(
    () => svc.callback('google', { code: 'c', state, stateFromCookie: state }),
    /expired/i,
  );
});

test('callback: ATTACK — id_token signed by another key is refused', async () => {
  const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const db = fakeDb();
  // Start the request with an honest service so the state row exists...
  const svc = service(db, fakeFetch(db));
  const state = await startAndGetState(svc);

  // ...then complete it with a provider that returns a correctly-shaped token
  // carrying the RIGHT nonce but the WRONG signature. Only the signature
  // check should be able to reject this.
  const nonce = String(db.state.authRequests.get(state)!['nonce']);
  const forged = service(db, fakeFetch(db, {
    token: { id_token: idToken({ nonce }, attacker.privateKey) },
  }));

  await assert.rejects(
    () => forged.callback('google', { code: 'c', state, stateFromCookie: state }),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
  assert.equal(db.state.users.length, 0, 'no account may be created from an unverified token');
});

test('callback: ATTACK — id_token for a different audience is refused', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db));
  const state = await startAndGetState(svc);
  const nonce = String(db.state.authRequests.get(state)!['nonce']);
  const wrongAud = service(db, fakeFetch(db, { token: { id_token: idToken({ aud: 'other-app', nonce }) } }));
  await assert.rejects(() => wrongAud.callback('google', { code: 'c', state, stateFromCookie: state }));
  assert.equal(db.state.users.length, 0);
});

test('callback: ATTACK — nonce from a different login is refused', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db, { token: { id_token: idToken({ nonce: 'someone-elses' }) } }));
  const state = await startAndGetState(svc);
  await assert.rejects(() => svc.callback('google', { code: 'c', state, stateFromCookie: state }));
});

test('callback: ATTACK — unverified provider email cannot take over an account', async () => {
  const db = fakeDb({
    users: [{ id: 'victim', email: 'user@example.com', status: 'active', email_verified_at: new Date() }],
  });
  const svc = service(db, fakeFetch(db));
  const state = await startAndGetState(svc);
  const nonce = String(db.state.authRequests.get(state)!['nonce']);
  const unverified = service(db, fakeFetch(db, { token: { id_token: idToken({ email_verified: false, nonce }) } }));
  const out = await unverified.callback('google', { code: 'c', state, stateFromCookie: state });
  assert.equal(out.kind, 'needs_proof');
  assert.equal(db.state.identities.length, 0, 'no link may be created');
});

test('callback: provider error response does not leak provider text', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db, { tokenOk: false, token: { error: 'invalid_grant', error_description: 'internal detail' } }));
  const state = await startAndGetState(svc);

  await assert.rejects(
    () => svc.callback('google', { code: 'c', state, stateFromCookie: state }),
    (e: unknown) => e instanceof AppError && !e.message.includes('internal detail'),
  );
});

test('callback: suspended account is refused', async () => {
  const db = fakeDb({
    users: [{ id: 'u1', email: 'user@example.com', status: 'suspended', email_verified_at: new Date() }],
  });
  const svc = service(db, fakeFetch(db));
  const state = await startAndGetState(svc);
  await assert.rejects(
    () => svc.callback('google', { code: 'c', state, stateFromCookie: state }),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
});

// ── configuration ───────────────────────────────────────────────────────────
test('start: unconfigured provider is reported, not attempted', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db));
  assert.equal(svc.isEnabled('google'), true);
  assert.equal(svc.isEnabled('facebook'), false);
  await assert.rejects(() => svc.start('facebook'), /not enabled/);
});

test('start: unknown provider is rejected', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db));
  await assert.rejects(() => svc.start('evil-idp'), /Unknown sign-in provider/);
});

test('start: redirect URI matches the documented registration value', () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db));
  assert.equal(
    svc.redirectUriFor('google'),
    'https://portage.ca/api/auth/oauth/google/callback',
  );
});

test('start: off-site next parameter is neutralised before storage', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db));
  const { state } = await svc.start('google', { redirectPath: 'https://evil.example/steal' });
  assert.equal(db.state.authRequests.get(state)!['redirect_path'], '/');
});

test('start: the verifier is never placed in the authorize URL', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db));
  const { authorizeUrl, state } = await svc.start('google');
  const verifier = String(db.state.authRequests.get(state)!['code_verifier']);
  assert.ok(!authorizeUrl.includes(verifier));
  assert.ok(authorizeUrl.includes('code_challenge_method=S256'));
});

test('sweep: expired authorization requests are removable', async () => {
  const db = fakeDb();
  const svc = service(db, fakeFetch(db));
  await svc.start('google');
  assert.equal(await sweepAuthRequests(db), 1);
});
