/**
 * HTTP layer tests. These drive the guard with real Web Request objects and a
 * fake session resolver, so they exercise the same code path production uses.
 *
 * The assertions are attacks: forged origins, missing CSRF, oversized bodies,
 * unknown fields, rate-limit evasion via spoofed forwarding headers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { guard, clientIpFrom, type GuardConfig } from '../src/http/guard.js';
import { json, errorResponse, preflight, type ResponseContext } from '../src/http/respond.js';
import { apiSecurityHeaders, corsHeaders, originAllowedForWrite } from '../src/http/headers.js';
import { RateLimiter, LIMITS } from '../src/lib/ratelimit.js';
import { createSessionMaterial, SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER } from '../src/lib/session.js';
import * as v from '../src/lib/validate.js';
import { AppError } from '../src/lib/errors.js';

const ORIGIN = 'https://portage.ca';
const ALLOWED = [ORIGIN];

/** A session resolver backed by a map, standing in for the database. */
function fakeAuth(sessions: Map<string, { userId: string; sessionId: string; csrfHash: Buffer }>) {
  return {
    async resolveSession(token: string) {
      return sessions.get(token) ?? null;
    },
  };
}

function makeCfg(over: Partial<GuardConfig> = {}): GuardConfig {
  return {
    allowedOrigins: ALLOWED,
    auth: fakeAuth(new Map()),
    pepper: 'test-pepper-value',
    trustProxy: false,
    limiters: {
      read: new RateLimiter(LIMITS.read),
      write: new RateLimiter(LIMITS.write),
      auth: new RateLimiter(LIMITS.login),
    },
    ...over,
  };
}

function req(
  method: string,
  opts: { origin?: string; cookie?: string; csrf?: string; body?: unknown; contentType?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.origin) headers['origin'] = opts.origin;
  if (opts.cookie) headers['cookie'] = opts.cookie;
  if (opts.csrf) headers[CSRF_HEADER] = opts.csrf;
  if (opts.body !== undefined) headers['content-type'] = opts.contentType ?? 'application/json';
  return new Request('https://api.portage.ca/x', {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function expectError(fn: () => Promise<unknown>, status: number, note: string) {
  try {
    await fn();
    assert.fail(`${note}: expected ${status}, but the request was allowed`);
  } catch (err) {
    assert.ok(err instanceof AppError, `${note}: expected AppError, got ${String(err)}`);
    assert.equal((err as AppError).status, status, note);
  }
}

// ── origin / CSRF ───────────────────────────────────────────────────────────
test('guard: write from an unknown origin is refused', async () => {
  await expectError(
    () => guard(req('POST', { origin: 'https://evil.example', body: {} }), makeCfg(), {
      requireAuth: false, limit: 'write',
    }),
    403,
    'cross-site write',
  );
});

test('guard: write with no Origin header at all is refused', async () => {
  await expectError(
    () => guard(req('POST', { body: {} }), makeCfg(), { requireAuth: false, limit: 'write' }),
    403,
    'missing origin on write',
  );
});

test('guard: GET from an unknown origin is allowed (reads are not state-changing)', async () => {
  const { ctx } = await guard(req('GET', { origin: 'https://evil.example' }), makeCfg(), {
    requireAuth: false, limit: 'read',
  });
  assert.equal(ctx.principal, null);
});

test('guard: authenticated write without a CSRF header is refused', async () => {
  const m = createSessionMaterial();
  const sessions = new Map([[m.sessionToken, { userId: 'u1', sessionId: 's1', csrfHash: m.csrfHash }]]);
  const cfg = makeCfg({ auth: fakeAuth(sessions) });

  await expectError(
    () => guard(
      req('POST', {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE}=${m.sessionToken}; ${CSRF_COOKIE}=${m.csrfToken}`,
        body: {},
      }),
      cfg,
      { requireAuth: true, limit: 'write' },
    ),
    403,
    'missing CSRF header',
  );
});

test('guard: authenticated write with matching CSRF is allowed', async () => {
  const m = createSessionMaterial();
  const sessions = new Map([[m.sessionToken, { userId: 'u1', sessionId: 's1', csrfHash: m.csrfHash }]]);
  const cfg = makeCfg({ auth: fakeAuth(sessions) });

  const { ctx } = await guard(
    req('POST', {
      origin: ORIGIN,
      cookie: `${SESSION_COOKIE}=${m.sessionToken}; ${CSRF_COOKIE}=${m.csrfToken}`,
      csrf: m.csrfToken,
      body: {},
    }),
    cfg,
    { requireAuth: true, limit: 'write' },
  );
  assert.equal(ctx.principal?.userId, 'u1');
});

test('guard: attacker-injected CSRF pair is refused', async () => {
  const m = createSessionMaterial();
  const other = createSessionMaterial();
  const sessions = new Map([[m.sessionToken, { userId: 'u1', sessionId: 's1', csrfHash: m.csrfHash }]]);
  const cfg = makeCfg({ auth: fakeAuth(sessions) });

  // Attacker sets both halves to a value they chose. Cookie and header agree,
  // but neither matches the digest stored on the session.
  await expectError(
    () => guard(
      req('POST', {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE}=${m.sessionToken}; ${CSRF_COOKIE}=${other.csrfToken}`,
        csrf: other.csrfToken,
        body: {},
      }),
      cfg,
      { requireAuth: true, limit: 'write' },
    ),
    403,
    'forged CSRF pair',
  );
});

// ── authentication ──────────────────────────────────────────────────────────
test('guard: requireAuth rejects an anonymous caller', async () => {
  await expectError(
    () => guard(req('GET'), makeCfg(), { requireAuth: true, limit: 'read' }),
    401,
    'anonymous',
  );
});

test('guard: an unknown session cookie is treated as anonymous, not an error', async () => {
  const { ctx } = await guard(
    req('GET', { cookie: `${SESSION_COOKIE}=not-a-real-token` }),
    makeCfg(),
    { requireAuth: false, limit: 'read' },
  );
  assert.equal(ctx.principal, null);
});

// ── body handling ───────────────────────────────────────────────────────────
const schema = v.object({ title: v.string({ min: 1, max: 50 }) });

test('guard: valid body parses', async () => {
  const { body } = await guard<{ title: string }>(
    req('POST', { origin: ORIGIN, body: { title: 'Bright 2BR' } }),
    makeCfg(),
    { requireAuth: false, limit: 'write', body: schema },
  );
  assert.equal(body.title, 'Bright 2BR');
});

test('guard: unknown fields are rejected', async () => {
  await expectError(
    () => guard(
      req('POST', { origin: ORIGIN, body: { title: 'ok', ownerId: 'someone-else' } }),
      makeCfg(),
      { requireAuth: false, limit: 'write', body: schema },
    ),
    400,
    'mass assignment',
  );
});

test('guard: non-JSON content type is rejected when a body is expected', async () => {
  await expectError(
    () => guard(
      req('POST', { origin: ORIGIN, body: { title: 'x' }, contentType: 'text/plain' }),
      makeCfg(),
      { requireAuth: false, limit: 'write', body: schema },
    ),
    400,
    'wrong content type',
  );
});

test('guard: malformed JSON is rejected', async () => {
  const r = new Request('https://api.portage.ca/x', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: '{ not json',
  });
  await expectError(
    () => guard(r, makeCfg(), { requireAuth: false, limit: 'write', body: schema }),
    400,
    'bad json',
  );
});

test('guard: oversized body is rejected', async () => {
  const big = { title: 'x'.repeat(300 * 1024) };
  await expectError(
    () => guard(req('POST', { origin: ORIGIN, body: big }), makeCfg(), {
      requireAuth: false, limit: 'write', body: schema,
    }),
    413,
    'oversized body',
  );
});

// ── rate limiting ───────────────────────────────────────────────────────────
test('guard: rate limit trips and reports a retry delay', async () => {
  const cfg = makeCfg();
  cfg.limiters.auth = new RateLimiter({ windowMs: 60_000, max: 2 });
  const call = () => guard(req('GET'), cfg, { requireAuth: false, limit: 'auth' });
  await call();
  await call();
  try {
    await call();
    assert.fail('third call should have been rate limited');
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal((err as AppError).status, 429);
    assert.ok((err as { retryAfterSec?: number }).retryAfterSec! >= 1);
  }
});

test('clientIp: forwarding headers are ignored unless the proxy is trusted', () => {
  const spoofed = new Request('https://api.portage.ca/x', {
    headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
  });
  // Untrusted: a client cannot pick its own rate-limit bucket.
  assert.equal(clientIpFrom(spoofed, false), 'direct');
  // Trusted: leftmost entry is the real client.
  assert.equal(clientIpFrom(spoofed, true), '1.2.3.4');
});

// ── responses ───────────────────────────────────────────────────────────────
const rctx = (over: Partial<ResponseContext> = {}): ResponseContext => ({
  requestId: 'req-1',
  origin: ORIGIN,
  allowedOrigins: ALLOWED,
  hsts: true,
  ...over,
});

test('response: security headers are present on every JSON response', () => {
  const res = json({ ok: true }, rctx());
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.match(res.headers.get('Content-Security-Policy') ?? '', /default-src 'none'/);
  assert.match(res.headers.get('Strict-Transport-Security') ?? '', /max-age=31536000/);
  assert.equal(res.headers.get('X-Request-Id'), 'req-1');
});

test('response: HSTS is omitted when not served over TLS', () => {
  const res = json({}, rctx({ hsts: false }));
  assert.equal(res.headers.get('Strict-Transport-Security'), null);
});

test('response: CORS echoes only allowlisted origins, never a wildcard', () => {
  const ok = json({}, rctx());
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(ok.headers.get('Access-Control-Allow-Credentials'), 'true');

  const bad = json({}, rctx({ origin: 'https://evil.example' }));
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);

  assert.equal(corsHeaders('*', ALLOWED), null);
  assert.equal(corsHeaders(undefined, ALLOWED), null);
});

test('response: preflight refuses unknown origins', async () => {
  assert.equal(preflight(rctx()).status, 204);
  assert.equal(preflight(rctx({ origin: 'https://evil.example' })).status, 403);
});

test('response: cookies are attached as separate Set-Cookie entries', () => {
  const res = json({}, rctx({ cookies: ['a=1; Path=/', 'b=2; Path=/'] }));
  const all = res.headers.getSetCookie?.() ?? [];
  assert.equal(all.length, 2);
});

test('response: internal errors never leak their message', async () => {
  const res = errorResponse(new Error('connection string postgres://user:hunter2@db'), rctx(), false);
  assert.equal(res.status, 500);
  const body = await res.json() as { error: { message: string; requestId: string } };
  assert.equal(body.error.message, 'Something went wrong on our end.');
  assert.ok(!JSON.stringify(body).includes('hunter2'));
  assert.equal(body.error.requestId, 'req-1');
});

test('response: AppError messages are returned deliberately', async () => {
  const res = errorResponse(new AppError(404, 'not_found', 'Document not found.'), rctx(), false);
  assert.equal(res.status, 404);
  const body = await res.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'not_found');
  assert.equal(body.error.message, 'Document not found.');
});

test('headers: originAllowedForWrite is strict', () => {
  assert.equal(originAllowedForWrite(ORIGIN, ALLOWED), true);
  assert.equal(originAllowedForWrite('https://portage.ca.evil.com', ALLOWED), false);
  assert.equal(originAllowedForWrite(undefined, ALLOWED), false);
  assert.equal(originAllowedForWrite('null', ALLOWED), false);
});

test('headers: API CSP forbids everything by default', () => {
  const h = apiSecurityHeaders({ hsts: false });
  const csp = h['Content-Security-Policy']!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
});
