/**
 * Response construction.
 *
 * Every response leaves through here so security headers cannot be forgotten
 * on a route someone adds later. Built on the Web Response standard, which is
 * what Next.js route handlers, Fastify 5, Deno and Bun all speak natively.
 */
import { apiSecurityHeaders, corsHeaders } from './headers.js';
import { toClientError } from '../lib/errors.js';

export interface ResponseContext {
  requestId: string;
  origin?: string | undefined;
  allowedOrigins: readonly string[];
  hsts: boolean;
  /** Set-Cookie values to attach (session issue/clear). */
  cookies?: string[];
}

function baseHeaders(ctx: ResponseContext): Headers {
  const h = new Headers(apiSecurityHeaders({ hsts: ctx.hsts }));
  h.set('X-Request-Id', ctx.requestId);
  const cors = corsHeaders(ctx.origin, ctx.allowedOrigins);
  if (cors) for (const [k, v] of Object.entries(cors)) h.set(k, v);
  for (const c of ctx.cookies ?? []) h.append('Set-Cookie', c);
  return h;
}

export function json(body: unknown, ctx: ResponseContext, status = 200): Response {
  const h = baseHeaders(ctx);
  h.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function noContent(ctx: ResponseContext): Response {
  return new Response(null, { status: 204, headers: baseHeaders(ctx) });
}

/**
 * Converts any thrown value into a safe response. Unknown errors lose their
 * message entirely — the caller gets a request id to quote, and the real
 * error goes to the log only.
 */
export function errorResponse(err: unknown, ctx: ResponseContext, log = true): Response {
  const { status, body } = toClientError(err, ctx.requestId);
  if (log && status >= 500) {
    console.error(
      JSON.stringify({
        level: 'error',
        requestId: ctx.requestId,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
  }
  const res = json(body, ctx, status);
  // Rate-limit responses must tell the client when to come back.
  if (status === 429 && err && typeof err === 'object' && 'retryAfterSec' in err) {
    res.headers.set('Retry-After', String((err as { retryAfterSec: number }).retryAfterSec));
  }
  return res;
}

/** Preflight. Returns 204 with CORS headers, or 403 when the origin is unknown. */
export function preflight(ctx: ResponseContext): Response {
  const cors = corsHeaders(ctx.origin, ctx.allowedOrigins);
  if (!cors) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: new Headers(cors) });
}
