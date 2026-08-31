/**
 * OTP routes: email verification and password reset.
 *
 * Rate limits here are stricter than elsewhere and are applied per identifier
 * as well as per IP, because a code is only six digits — a request endpoint
 * without a cap is a way to spray codes at an inbox, and a verify endpoint
 * without one is a way to grind through a million possibilities.
 */
import * as v from '../../lib/validate.js';
import { guard, type GuardConfig } from '../guard.js';
import { json, noContent, errorResponse, type ResponseContext } from '../respond.js';
import { REQUEST_ACK, type OtpFlows } from '../../modules/auth/otp/flows.js';
import { tooManyRequests } from '../../lib/errors.js';
import type { Limiter } from '../../lib/ratelimit-db.js';

export interface OtpRouteDeps {
  cfg: GuardConfig;
  flows: OtpFlows;
  hsts: boolean;
  /** Per-identifier limiter, separate from the guard's per-IP buckets. */
  identifierLimiter: Limiter;
}

const requestResetBody = v.object({ email: v.email() });

const confirmResetBody = v.object({
  email: v.email(),
  code: v.string({ min: 6, max: 6, pattern: /^\d{6}$/ }),
  newPassword: v.string({ min: 12, max: 256, trim: false }),
});

const confirmVerifyBody = v.object({
  code: v.string({ min: 6, max: 6, pattern: /^\d{6}$/ }),
});

function ctxOf(requestId: string, origin: string | undefined, deps: OtpRouteDeps): ResponseContext {
  return { requestId, origin, allowedOrigins: deps.cfg.allowedOrigins, hsts: deps.hsts };
}

/** Caps activity against one address, independent of the caller's IP. */
async function limitByIdentifier(deps: OtpRouteDeps, scope: string, identifier: string): Promise<void> {
  const verdict = await deps.identifierLimiter.check(`${scope}:${identifier}`);
  if (!verdict.allowed) {
    throw tooManyRequests('Too many requests for this account. Try again shortly.');
  }
}

/** POST /api/auth/verify-email/request — signed in. */
export async function requestEmailVerification(req: Request, deps: OtpRouteDeps): Promise<Response> {
  let id = '';
  let origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'auth' });
    id = ctx.requestId;
    origin = ctx.origin;

    await limitByIdentifier(deps, 'verify-email', ctx.principal!.userId);
    const out = await deps.flows.requestEmailVerification(ctx.principal!.userId);

    return json(
      { sent: out.sent, message: out.sent ? REQUEST_ACK : 'Your email is already verified.' },
      ctxOf(ctx.requestId, ctx.origin, deps),
    );
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** POST /api/auth/verify-email/confirm — signed in. */
export async function confirmEmailVerification(req: Request, deps: OtpRouteDeps): Promise<Response> {
  let id = '';
  let origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ code: string }>(req, deps.cfg, {
      requireAuth: true,
      limit: 'auth',
      body: confirmVerifyBody,
    });
    id = ctx.requestId;
    origin = ctx.origin;

    await limitByIdentifier(deps, 'verify-email-confirm', ctx.principal!.userId);
    await deps.flows.confirmEmailVerification(ctx.principal!.userId, body.code);

    return json({ verified: true }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/**
 * POST /api/auth/password-reset/request — anonymous.
 *
 * Always 200 with the same body. Whether the address exists is not the
 * caller's business.
 */
export async function requestPasswordReset(req: Request, deps: OtpRouteDeps): Promise<Response> {
  let id = '';
  let origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ email: string }>(req, deps.cfg, {
      requireAuth: false,
      limit: 'auth',
      body: requestResetBody,
    });
    id = ctx.requestId;
    origin = ctx.origin;

    await limitByIdentifier(deps, 'password-reset', body.email);
    const out = await deps.flows.requestPasswordReset(body.email);

    return json(out, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** POST /api/auth/password-reset/confirm — anonymous. */
export async function confirmPasswordReset(req: Request, deps: OtpRouteDeps): Promise<Response> {
  let id = '';
  let origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ email: string; code: string; newPassword: string }>(
      req,
      deps.cfg,
      { requireAuth: false, limit: 'auth', body: confirmResetBody },
    );
    id = ctx.requestId;
    origin = ctx.origin;

    await limitByIdentifier(deps, 'password-reset-confirm', body.email);
    await deps.flows.confirmPasswordReset({
      email: body.email,
      code: body.code,
      newPassword: body.newPassword,
    });

    // 204: the client must send the user to sign in again, since every
    // session was just revoked — including any the caller was holding.
    return noContent(ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}
