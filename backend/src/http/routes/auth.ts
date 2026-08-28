/**
 * Authentication routes.
 *
 * Signup and login deliberately return the same shape and set cookies the
 * same way, so a caller cannot distinguish "this email exists" from "wrong
 * password" by inspecting the response.
 */
import * as v from '../../lib/validate.js';
import { guard, type GuardConfig } from '../guard.js';
import { json, noContent, errorResponse, type ResponseContext } from '../respond.js';
import {
  SESSION_COOKIE,
  CSRF_COOKIE,
  ABSOLUTE_TTL_MS,
  serializeCookie,
  clearCookie,
} from '../../lib/session.js';
import type { AuthService } from '../../modules/auth/service.js';
import { unauthorized } from '../../lib/errors.js';

export interface RouteDeps {
  cfg: GuardConfig;
  auth: AuthService;
  secureCookies: boolean;
  hsts: boolean;
}

const credentials = v.object({
  email: v.email(),
  password: v.string({ min: 12, max: 256, trim: false }),
});

function respCtx(
  requestId: string,
  origin: string | undefined,
  deps: RouteDeps,
  cookies?: string[],
): ResponseContext {
  return {
    requestId,
    origin,
    allowedOrigins: deps.cfg.allowedOrigins,
    hsts: deps.hsts,
    ...(cookies ? { cookies } : {}),
  };
}

/** Cookies issued on a successful signup or login. */
function sessionCookies(
  sessionToken: string,
  csrfToken: string,
  secure: boolean,
): string[] {
  return [
    // HttpOnly: JavaScript must never read the session token.
    serializeCookie(SESSION_COOKIE, sessionToken, { secure, maxAgeMs: ABSOLUTE_TTL_MS }),
    // Readable by the frontend on purpose — it has to echo the value back in
    // the CSRF header. That is the "double submit" half of the defence.
    serializeCookie(CSRF_COOKIE, csrfToken, {
      secure,
      maxAgeMs: ABSOLUTE_TTL_MS,
      httpOnly: false,
    }),
  ];
}

export async function signup(req: Request, deps: RouteDeps): Promise<Response> {
  let ctxId = '';
  let origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ email: string; password: string }>(req, deps.cfg, {
      requireAuth: false,
      limit: 'auth',
      body: credentials,
    });
    ctxId = ctx.requestId;
    origin = ctx.origin;

    const issued = await deps.auth.signup({
      email: body.email,
      password: body.password,
      ip: ctx.clientIp,
      userAgent: req.headers.get('user-agent') ?? undefined,
    });

    return json(
      { user: { id: issued.userId, email: body.email } },
      respCtx(ctx.requestId, ctx.origin, deps,
        sessionCookies(issued.sessionToken, issued.csrfToken, deps.secureCookies)),
      201,
    );
  } catch (err) {
    return errorResponse(err, respCtx(ctxId || 'unknown', origin, deps));
  }
}

export async function login(req: Request, deps: RouteDeps): Promise<Response> {
  let ctxId = '';
  let origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ email: string; password: string }>(req, deps.cfg, {
      requireAuth: false,
      limit: 'auth',
      body: credentials,
    });
    ctxId = ctx.requestId;
    origin = ctx.origin;

    const issued = await deps.auth.login({
      email: body.email,
      password: body.password,
      ip: ctx.clientIp,
      userAgent: req.headers.get('user-agent') ?? undefined,
    });

    return json(
      { user: { id: issued.userId, email: body.email } },
      respCtx(ctx.requestId, ctx.origin, deps,
        sessionCookies(issued.sessionToken, issued.csrfToken, deps.secureCookies)),
      200,
    );
  } catch (err) {
    return errorResponse(err, respCtx(ctxId || 'unknown', origin, deps));
  }
}

export async function logout(req: Request, deps: RouteDeps): Promise<Response> {
  let ctxId = '';
  let origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'write' });
    ctxId = ctx.requestId;
    origin = ctx.origin;

    await deps.auth.logout(ctx.principal!.sessionId);

    return noContent(
      respCtx(ctx.requestId, ctx.origin, deps, [
        clearCookie(SESSION_COOKIE, deps.secureCookies),
        clearCookie(CSRF_COOKIE, deps.secureCookies),
      ]),
    );
  } catch (err) {
    return errorResponse(err, respCtx(ctxId || 'unknown', origin, deps));
  }
}

/** Returns the current principal. Used by the frontend to bootstrap state. */
export async function me(req: Request, deps: RouteDeps): Promise<Response> {
  let ctxId = '';
  let origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: false, limit: 'read' });
    ctxId = ctx.requestId;
    origin = ctx.origin;
    if (!ctx.principal) throw unauthorized();
    return json({ userId: ctx.principal.userId }, respCtx(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, respCtx(ctxId || 'unknown', origin, deps));
  }
}
