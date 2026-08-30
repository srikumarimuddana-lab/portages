/**
 * The request guard: the single gate every route passes through.
 *
 * Order matters and is deliberate — each check is cheaper than the one after
 * it, so an attacker cannot make us do expensive work before being rejected:
 *
 *   1. Method + content type   (free)
 *   2. Origin allowlist        (free, and blocks cross-site writes early)
 *   3. Rate limit              (local cache first, then shared Postgres state)
 *   4. Body size + JSON parse  (bounded)
 *   5. Session lookup          (one indexed query)
 *   6. CSRF                    (constant-time compare against stored digest)
 *   7. Schema validation       (only now do we touch the payload's shape)
 *
 * Authentication before CSRF is intentional: CSRF is verified against the
 * digest stored on the session, so the session must be resolved first.
 */
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  parseCookies,
  requiresCsrf,
  verifyCsrf,
} from '../lib/session.js';
import { isJsonContentType, originAllowedForWrite, MAX_JSON_BYTES } from './headers.js';
import type { Limiter } from '../lib/ratelimit-db.js';
import {
  badRequest,
  forbidden,
  notFound,
  payloadTooLarge,
  tooManyRequests,
  unauthorized,
  AppError,
} from '../lib/errors.js';
import type { Schema } from '../lib/validate.js';
import { generateToken, pseudonymize } from '../lib/crypto.js';
import type { ResolvedSession, UserRole } from '../modules/auth/service.js';

export interface Principal {
  userId: string;
  sessionId: string;
  /**
   * Resolved from the database on every request, never from the cookie. A
   * role carried in a token is a role that keeps working after it is taken
   * away.
   */
  role: UserRole;
}

export interface GuardContext {
  requestId: string;
  origin: string | undefined;
  clientIp: string;
  principal: Principal | null;
}

export interface SessionResolver {
  resolveSession(token: string): Promise<ResolvedSession | null>;
}

export interface GuardConfig {
  allowedOrigins: readonly string[];
  auth: SessionResolver;
  pepper: string;
  trustProxy: boolean;
  /**
   * Both the in-process RateLimiter and the Postgres-backed
   * DurableRateLimiter satisfy Limiter, so the transport does not care which
   * is wired in. Production uses the durable one — see ratelimit-db.ts for
   * why per-process counters are wrong on serverless.
   */
  limiters: {
    read: Limiter;
    write: Limiter;
    auth: Limiter;
  };
}

export interface GuardOptions {
  /** Reject anonymous callers. */
  requireAuth: boolean;
  /** Which limiter bucket applies. */
  limit: keyof GuardConfig['limiters'];
  /** Validate and return the JSON body against this schema. */
  body?: Schema<unknown>;
  /** Restrict to these roles. Implies requireAuth. */
  requireRole?: readonly UserRole[];
}

export interface Guarded<T> {
  ctx: GuardContext;
  body: T;
}

/** Rate-limit errors carry the retry hint so respond.ts can set Retry-After. */
class RateLimitError extends AppError {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(429, 'rate_limited', 'Too many requests. Try again shortly.');
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * Derives the client IP. Only trusts forwarding headers when explicitly
 * configured — otherwise any client could spoof X-Forwarded-For and evade
 * rate limits entirely.
 */
export function clientIpFrom(req: Request, trustProxy: boolean): string {
  if (!trustProxy) return 'direct';
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    // Leftmost entry is the original client; the rest are proxies.
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function guard<T = undefined>(
  req: Request,
  cfg: GuardConfig,
  opts: GuardOptions,
): Promise<Guarded<T>> {
  const requestId = generateToken(12);
  const origin = req.headers.get('origin') ?? undefined;
  const clientIp = clientIpFrom(req, cfg.trustProxy);
  const ctx: GuardContext = { requestId, origin, clientIp, principal: null };

  // 1 + 2. Cross-site write protection, before any work.
  const isWrite = requiresCsrf(req.method);
  if (isWrite && !originAllowedForWrite(origin, cfg.allowedOrigins)) {
    throw forbidden('Request origin is not allowed.');
  }

  // 3. Rate limit, keyed by a pseudonymized IP so raw addresses are not
  //    retained in memory or logs.
  const limiter = cfg.limiters[opts.limit];
  const key = pseudonymize(clientIp, cfg.pepper).toString('base64url');
  const verdict = await limiter.check(key);
  if (!verdict.allowed) throw new RateLimitError(verdict.retryAfterSec);

  // 4. Body: bounded read, then parse. Content-Length is a hint, not a
  //    guarantee, so the actual bytes are counted too.
  let body: unknown = undefined;
  if (opts.body) {
    if (!isJsonContentType(req.headers.get('content-type') ?? undefined)) {
      throw badRequest('Content-Type must be application/json.');
    }
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw payloadTooLarge();

    const raw = await readBounded(req, MAX_JSON_BYTES);
    try {
      body = JSON.parse(raw);
    } catch {
      throw badRequest('Request body is not valid JSON.');
    }
  }

  // 5. Session.
  const cookies = parseCookies(req.headers.get('cookie') ?? undefined);
  const sessionToken = cookies[SESSION_COOKIE];
  let csrfHash: Buffer | null = null;

  if (sessionToken) {
    const resolved = await cfg.auth.resolveSession(sessionToken);
    if (resolved) {
      ctx.principal = {
        userId: resolved.userId,
        sessionId: resolved.sessionId,
        role: resolved.role,
      };
      csrfHash = resolved.csrfHash;
    }
  }
  if (opts.requireAuth && !ctx.principal) throw unauthorized();

  // Role gate. Deliberately a 404, not a 403: an admin route that answers
  // "forbidden" to a non-staff caller has just confirmed the route exists and
  // is worth attacking. To everyone without the role, it is not there.
  if (opts.requireRole && (!ctx.principal || !opts.requireRole.includes(ctx.principal.role))) {
    throw notFound();
  }

  // 6. CSRF, for authenticated writes. An anonymous write (signup, login) has
  //    no session to protect, and the origin check above already covers it.
  if (isWrite && ctx.principal) {
    if (!csrfHash) throw forbidden('Missing CSRF material.');
    const ok = verifyCsrf(
      req.headers.get(CSRF_HEADER) ?? undefined,
      cookies[CSRF_COOKIE],
      csrfHash,
    );
    if (!ok) throw forbidden('CSRF validation failed.');
  }

  // 7. Schema.
  if (opts.body) {
    const parsed = opts.body.parse(body);
    if (!parsed.ok) throw badRequest('Request body is invalid.', parsed.errors);
    return { ctx, body: parsed.value as T };
  }
  return { ctx, body: undefined as T };
}

/**
 * Reads the body while enforcing a hard byte ceiling. A client that lies in
 * Content-Length is cut off mid-stream rather than allowed to exhaust memory.
 */
async function readBounded(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) throw payloadTooLarge();
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(joined);
}
