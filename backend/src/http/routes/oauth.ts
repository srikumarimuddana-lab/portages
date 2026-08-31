/**
 * OAuth routes.
 *
 * Two endpoints, both GET because the browser arrives by redirect:
 *
 *   GET /api/auth/oauth/:provider          -> 302 to the provider
 *   GET /api/auth/oauth/:provider/callback -> 302 back into the app
 *
 * Neither returns JSON on success: the user is a browser following redirects,
 * and errors are surfaced as a redirect carrying a short code rather than a
 * raw message, so nothing from a provider is ever reflected into the page.
 */
import { guard, type GuardConfig } from '../guard.js';
import { errorResponse, type ResponseContext } from '../respond.js';
import { serializeCookie, clearCookie, parseCookies, ABSOLUTE_TTL_MS, SESSION_COOKIE, CSRF_COOKIE } from '../../lib/session.js';
import { safeRedirectPath } from '../../modules/auth/oauth/pkce.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { isFlagKey } from '../../modules/flags/registry.js';
import type { OAuthService } from '../../modules/auth/oauth/service.js';
import type { AuthService } from '../../modules/auth/service.js';

/** Browser-bound copy of `state`, so a stolen code cannot be injected. */
const STATE_COOKIE = '__Host-portage_oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthRouteDeps {
  cfg: GuardConfig;
  oauth: OAuthService;
  auth: AuthService;
  secureCookies: boolean;
  hsts: boolean;
  /** Where the browser lands after a completed or failed sign-in. */
  appOrigin: string;
}

function ctxOf(requestId: string, origin: string | undefined, deps: OAuthRouteDeps, cookies?: string[]): ResponseContext {
  return {
    requestId,
    origin,
    allowedOrigins: deps.cfg.allowedOrigins,
    hsts: deps.hsts,
    ...(cookies ? { cookies } : {}),
  };
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    location,
    // A redirect that sets a session must never be cached.
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

/** GET /api/auth/oauth/:provider — begin sign-in. */
export async function oauthStart(
  req: Request,
  providerId: string,
  deps: OAuthRouteDeps,
): Promise<Response> {
  let id = '';
  let origin: string | undefined;
  try {
    // The key is per provider, so it cannot be a static `requireFlag`. Per
    // provider rather than one switch on purpose: the failure that calls for
    // this is one provider's outage or a leaked client secret, and taking the
    // other login route down alongside it helps nobody.
    //
    // An unrecognised provider is left ungated — OAuthService refuses it a
    // few lines later, and deriving a flag key from an arbitrary path segment
    // is how a URL becomes a way to probe the registry.
    const { ctx } = await guard(req, deps.cfg, {
      requireAuth: false,
      limit: 'auth',
      ...flagFor(providerId),
    });
    id = ctx.requestId;
    origin = ctx.origin;

    const url = new URL(req.url);
    const next = safeRedirectPath(url.searchParams.get('next'));

    // A signed-in caller is linking a provider to their existing account
    // rather than signing in. linking.ts treats that as proof of control.
    const linkingUserId = ctx.principal?.userId;

    const { authorizeUrl, state } = await deps.oauth.start(providerId, {
      redirectPath: next,
      linkingUserId,
    });

    return redirect(authorizeUrl, [
      serializeCookie(STATE_COOKIE, state, {
        secure: deps.secureCookies,
        maxAgeMs: STATE_TTL_MS,
      }),
    ]);
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** GET /api/auth/oauth/:provider/callback — complete sign-in. */
export async function oauthCallback(
  req: Request,
  providerId: string,
  deps: OAuthRouteDeps,
): Promise<Response> {
  let id = '';
  let origin: string | undefined;
  const clearState = clearCookie(STATE_COOKIE, deps.secureCookies);

  try {
    // The callback is gated too, and that is a deliberate difference from the
    // upload switch, which lets in-flight work finish. An upload completing
    // after the switch is harmless — the bytes are already paid for. A
    // callback completing after the switch mints a session using the very
    // credential the switch was thrown over, which is the thing being
    // stopped. A user caught mid-flow re-authenticates by another route.
    const { ctx } = await guard(req, deps.cfg, {
      requireAuth: false,
      limit: 'auth',
      ...flagFor(providerId),
    });
    id = ctx.requestId;
    origin = ctx.origin;

    const url = new URL(req.url);
    const providerError = url.searchParams.get('error');
    if (providerError) {
      // The user declined, or the provider refused. Not an error condition
      // worth a 500 — send them back with a code the app can explain.
      return redirect(`${deps.appOrigin}/signin?error=provider_declined`, [clearState]);
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) throw badRequest('Missing authorization response.');

    const cookies = parseCookies(req.headers.get('cookie') ?? undefined);

    const outcome = await deps.oauth.callback(
      providerId,
      { code, state, stateFromCookie: cookies[STATE_COOKIE] },
      { ip: ctx.clientIp, userAgent: req.headers.get('user-agent') ?? undefined },
    );

    if (outcome.kind === 'needs_proof') {
      // A local account exists but automatic linking would be unsafe. Send
      // the user to a page that asks them to prove control of one side.
      return redirect(`${deps.appOrigin}/signin?verify=1&provider=${encodeURIComponent(providerId)}`, [
        clearState,
      ]);
    }

    const issued = await deps.auth.createSessionForAuthenticatedUser(outcome.userId, {
      ip: ctx.clientIp,
      userAgent: req.headers.get('user-agent') ?? undefined,
    });

    return redirect(`${deps.appOrigin}${outcome.redirectPath}`, [
      clearState,
      serializeCookie(SESSION_COOKIE, issued.sessionToken, {
        secure: deps.secureCookies,
        maxAgeMs: ABSOLUTE_TTL_MS,
      }),
      // Readable by the frontend on purpose: it must echo this value back in
      // the CSRF header. That is the double-submit half of the defence.
      serializeCookie(CSRF_COOKIE, issued.csrfToken, {
        secure: deps.secureCookies,
        maxAgeMs: ABSOLUTE_TTL_MS,
        httpOnly: false,
      }),
    ]);
  } catch (err) {
    // Redirect rather than render: an error page on the callback URL is a
    // place attackers like to plant content.
    if (err instanceof AppError && err.status < 500) {
      return redirect(`${deps.appOrigin}/signin?error=signin_failed`, [clearState]);
    }
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps, [clearState]));
  }
}

/** The kill switch for one provider, or nothing when it is not a known one. */
function flagFor(providerId: string): { requireFlag?: 'oauth.google' | 'oauth.facebook' } {
  const key = `oauth.${providerId}`;
  return isFlagKey(key) && (key === 'oauth.google' || key === 'oauth.facebook')
    ? { requireFlag: key }
    : {};
}
