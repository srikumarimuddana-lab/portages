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
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
  AppError,
} from '../lib/errors.js';
import { FLAGS, type FlagKey } from '../modules/flags/registry.js';
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

/**
 * What the guard needs from the flags module, narrowed so it cannot flip one.
 * Satisfied by FlagService.
 */
export interface FlagReader {
  isEnabled(key: FlagKey, subjectId?: string | null): Promise<boolean>;
}

/**
 * What a caller is told when a switch is thrown.
 *
 * Written for the person who hits it, not for a log. "Temporarily
 * unavailable" sends someone to refresh for an hour; saying what is off and
 * what still works tells them whether to wait or to do something else.
 */
const FLAG_OFF_MESSAGE: Partial<Record<FlagKey, string>> = {
  'signups.new': 'New accounts are paused right now. Existing accounts can still sign in.',
  'listings.new': 'New listings are paused right now. You can still edit and publish listings you already have.',
  'uploads.new': 'Uploads are paused right now. Everything already uploaded is unaffected.',
  'oauth.google': 'Google sign-in is unavailable right now. You can sign in with your email and password.',
  'oauth.facebook': 'Facebook sign-in is unavailable right now. You can sign in with your email and password.',
};

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
  /**
   * Absent means no flag gating in this deployment; a route declaring
   * `requireFlag` then falls back to that flag's registry fail-safe.
   */
  flags?: FlagReader;
}

interface GuardOptionsBase {
  /** Reject anonymous callers. */
  requireAuth: boolean;
  /** Which limiter bucket applies. */
  limit: keyof GuardConfig['limiters'];
  /** Validate and return the JSON body against this schema. */
  body?: Schema<unknown>;
}

/**
 * `requireRole` and `requireFlag` are mutually exclusive, and the type says so
 * because a comment would not hold.
 *
 * Two rules collide on a route that wanted both, and they cannot both be
 * satisfied by an ordering:
 *
 *   - a role-gated route must answer 404 to everyone without the role, so a
 *     stranger cannot tell it exists;
 *   - a switched-off route answers 503, which says it exists.
 *
 * Checking the flag first leaks the admin surface to anyone with a URL list.
 * Checking it last would make every public flag-gated route pay for session
 * resolution and body parsing before a refusal that costs one cached boolean.
 *
 * Neither trade is necessary, because the combination should not exist:
 * **no admin route is ever flag-gated.** The console is how a thrown switch
 * gets released, and a switch that can disable its own off-switch is a trap
 * whose only exit is the deploy this whole layer exists to avoid. Making it a
 * type error is how that stays true after everyone who read this has left.
 */
export type GuardOptions =
  | (GuardOptionsBase & {
      /** Restrict to these roles. Implies requireAuth. Never with requireFlag. */
      requireRole: readonly UserRole[];
      requireFlag?: never;
    })
  | (GuardOptionsBase & {
      requireRole?: never;
      /**
       * Refuse with 503 while this kill switch is off. Declared per route so
       * the check cannot be forgotten in one branch of a handler.
       */
      requireFlag?: FlagKey;
    });

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

  // 3b. Kill switch, if this route declares one. After the rate limit so a
  //     switched-off endpoint is still throttled rather than becoming a free
  //     thing to hammer, and before the body is read so a disabled capability
  //     costs one cached boolean.
  //
  //     503, not 403 or 404: the route exists, the caller is not the problem,
  //     and it will work again. That is what a 503 means, and it is the one
  //     status a client can sensibly retry.
  //
  //     No admin route is ever flag-gated. The console is how a thrown switch
  //     gets un-thrown, and a switch that can disable its own off-switch is a
  //     trap with no way out.
  //     The `!requireRole` clause is unreachable through the type above, which
  //     forbids the combination. It is here because types are erased: if the
  //     pair is ever forced past them, the role gate must still govern, and a
  //     404 must not turn into a 503 that confirms an admin route exists.
  //     Ignoring the switch is the right fallback rather than a compromise —
  //     an admin route is one that must never be switchable in the first place.
  if (opts.requireFlag && !opts.requireRole) {
    // Absent reader means the flags module is not wired in this deployment —
    // not that the store is down. Either way the honest answer is the same
    // one the service gives when it cannot read: the registry's fail-safe.
    const on = cfg.flags
      ? await cfg.flags.isEnabled(opts.requireFlag)
      : FLAGS[opts.requireFlag].failsafe;
    if (!on) throw serviceUnavailable(FLAG_OFF_MESSAGE[opts.requireFlag] ?? undefined);
  }

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
  // Role gate. Deliberately a 404, not a 403: an admin route that answers
  // "forbidden" to a non-staff caller has just confirmed the route exists and
  // is worth attacking. To everyone without the role, it is not there.
  //
  // It runs BEFORE the auth check, not after, and the order is the point. A
  // 401 to an anonymous caller says "there is something here worth logging in
  // for" just as loudly as a 403 does — it would leak the whole admin surface
  // to anyone with a URL list and no session at all, which is the cheapest
  // possible probe.
  if (opts.requireRole && (!ctx.principal || !opts.requireRole.includes(ctx.principal.role))) {
    throw notFound();
  }
  if (opts.requireAuth && !ctx.principal) throw unauthorized();

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
