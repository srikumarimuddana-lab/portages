/**
 * HTML form handling.
 *
 * THE PROBLEM THIS SOLVES. The JSON API's guard requires `application/json`
 * and a CSRF value in a REQUEST HEADER. A plain `<form>` can send neither: it
 * posts `application/x-www-form-urlencoded`, and there is no markup that adds
 * a header. So the pages rendered so far looked right and submitted nothing.
 *
 * Two ways out. Intercept every submit with JavaScript and re-send it as JSON
 * — which makes the whole site depend on a script for its most basic actions
 * — or accept form posts properly on the server. This is the second.
 *
 * CSRF IS NOT WEAKENED BY THIS, and that is the part worth checking rather
 * than taking on trust. The existing defence is double-submit: a value in a
 * cookie must equal a value the page sends back, and both must match a digest
 * stored on the session row. The reason it works is that an attacker's site
 * cannot READ our cookie, so it cannot produce the matching value — nothing
 * about that argument mentions headers. A hidden input carries the same value
 * with the same property, and `verifyCsrf` is reused unchanged: its first
 * parameter is "the value the page presented", not "the header".
 *
 * Two further checks apply to every form post here:
 *   - the Origin header must be one of ours, exactly as the JSON guard requires
 *   - the session must resolve, and the CSRF digest is read from that row
 *
 * POST/REDIRECT/GET throughout. A form that renders its result in the POST
 * response leaves the browser holding a resubmittable request: refresh, and
 * you have sent the message twice. Every handler here ends in a 303.
 */
import {
  CSRF_COOKIE, SESSION_COOKIE, parseCookies, verifyCsrf,
} from '../lib/session.js';
import { originAllowedForWrite } from '../http/headers.js';
import type { App } from '../http/app.js';
import type { Viewer } from './layout.js';

/** Bigger than any form here, small enough that a junk post costs nothing. */
const MAX_FORM_BYTES = 128 * 1024;

export const CSRF_FIELD = 'csrf';

export interface FormContext {
  viewer: Viewer;
  fields: FormFields;
}

/**
 * Parsed form values.
 *
 * `get` returns a single value and `all` returns every one, because a
 * checkbox group posts the same name repeatedly and silently taking only the
 * first is how "parking, dishwasher, balcony" becomes "parking".
 */
export class FormFields {
  readonly #params: URLSearchParams;

  constructor(params: URLSearchParams) {
    this.#params = params;
  }

  get(name: string): string {
    return (this.#params.get(name) ?? '').trim();
  }

  /**
   * The value exactly as sent, with no trimming.
   *
   * For passwords, and only for passwords. A space at either end of a password
   * is a character the person chose; `get` would remove it, which means a
   * password set through the JSON API (where the validator is explicitly
   * `trim: false`) could never be typed into this form. Trimming on the way in
   * and on the way out is consistent only until the two doors disagree.
   */
  raw(name: string): string {
    return this.#params.get(name) ?? '';
  }

  all(name: string): string[] {
    return this.#params.getAll(name).map((v) => v.trim()).filter(Boolean);
  }

  /** Absent, empty, or unparseable all give undefined rather than NaN. */
  int(name: string): number | undefined {
    const raw = this.get(name);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }

  num(name: string): number | undefined {
    const raw = this.get(name);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  /** An unchecked checkbox posts nothing at all, which is what makes it false. */
  bool(name: string): boolean {
    const v = this.get(name).toLowerCase();
    return v === 'on' || v === 'true' || v === '1' || v === 'yes';
  }
}

export class FormError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FormError';
    this.status = status;
  }
}

/** Reads the body with a hard cap, so a huge post cannot be a denial of service. */
async function readBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) {
    throw new FormError('That form is too large.', 413);
  }
  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    // Content-Length is a hint, not a guarantee, so the real bytes are counted
    // too — the same rule the JSON guard follows.
    if (total > MAX_FORM_BYTES) throw new FormError('That form is too large.', 413);
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(concat(chunks, total));
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * The gate every form post passes through.
 *
 * Order mirrors the JSON guard: cheapest check first, and nothing expensive
 * happens for a request that was never going to be accepted.
 */
export async function readForm(
  req: Request,
  app: App,
  opts: { requireAuth?: boolean } = {},
): Promise<{
  viewer: Viewer | null;
  /**
   * The SESSION id, carried separately from the viewer.
   *
   * `AuthService.logout` revokes a session row by its own id, not by the
   * user's — so passing a user id there compiles, runs, revokes nothing, and
   * leaves the person signed in while telling them they are out.
   */
  sessionId: string | null;
  fields: FormFields;
}> {
  // 1. Origin. Free, and it stops a cross-site post before anything is read.
  if (!originAllowedForWrite(req.headers.get('origin') ?? undefined, app.cfg.allowedOrigins)) {
    throw new FormError('That request did not come from Portage.', 403);
  }

  const ct = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.startsWith('application/x-www-form-urlencoded')) {
    throw new FormError('Unsupported form encoding.', 415);
  }

  // 2. Session, because the CSRF digest lives on it.
  const cookies = parseCookies(req.headers.get('cookie') ?? undefined);
  const token = cookies[SESSION_COOKIE];
  const resolved = token ? await app.auth.resolveSession(token) : null;

  if (opts.requireAuth !== false && !resolved) {
    throw new FormError('Sign in to do that.', 401);
  }

  const fields = new FormFields(new URLSearchParams(await readBody(req)));

  // 3. CSRF, for any post from a signed-in caller.
  //
  //    Anonymous posts (sign in, sign up) carry no session to protect and
  //    have no digest to check against; the origin check above is what covers
  //    them, exactly as it does on the JSON side.
  if (resolved) {
    const ok = verifyCsrf(
      fields.get(CSRF_FIELD) || undefined,
      cookies[CSRF_COOKIE],
      resolved.csrfHash,
    );
    if (!ok) {
      // Deliberately vague. "Your CSRF token did not match the session digest"
      // helps an attacker calibrate and helps a real user not at all; the fix
      // for the real user is always the same.
      throw new FormError('That form has expired. Reload the page and try again.', 403);
    }
  }

  return {
    viewer: resolved ? { userId: resolved.userId, role: resolved.role } : null,
    sessionId: resolved?.sessionId ?? null,
    fields,
  };
}

/**
 * POST/Redirect/GET, with a one-shot message.
 *
 * The message rides in the query string rather than in a cookie or a server
 * session. It is one short line the page it lands on knows how to render, it
 * disappears on the next navigation, and it needs no storage — the cost is
 * that it is visible in the URL, which is fine for "Your listing was
 * submitted" and is why nothing sensitive is ever put here.
 */
export function redirectTo(
  path: string,
  opts: {
    notice?: string;
    error?: string;
    cookies?: string[];
    /**
     * Extra query parameters, merged into the same string as the flash.
     *
     * Here rather than appended to `path` by the caller because a caller that
     * writes `` `${path}?x=1` `` and then passes a notice gets two `?` in one
     * URL, and the second half is silently discarded by the browser.
     */
    query?: URLSearchParams;
  } = {},
): Response {
  const q = new URLSearchParams(opts.query);
  if (opts.notice) q.set('notice', opts.notice);
  if (opts.error) q.set('error', opts.error);
  const qs = q.toString();

  const headers = new Headers({
    // 303, not 302: it tells the browser to follow with GET, which is the
    // whole point. A 302 after a POST is followed with GET by every browser
    // in practice but is not what the spec says, and the difference shows up
    // in exactly the tools that matter.
    location: qs ? `${path}?${qs}` : path,
    'cache-control': 'no-store',
  });
  for (const c of opts.cookies ?? []) headers.append('set-cookie', c);

  return new Response(null, { status: 303, headers });
}

/** Reads a flash message back off the query string, bounded. */
export function flashOf(url: URL): { notice: string | null; error: string | null } {
  const cut = (v: string | null) => (v ? v.slice(0, 300) : null);
  return { notice: cut(url.searchParams.get('notice')), error: cut(url.searchParams.get('error')) };
}

/**
 * Turns any thrown value into something a person can act on.
 *
 * The services throw `AppError` with messages already written for a client —
 * "Give a reason.", "That message has already been delivered." — so those are
 * passed through. Anything else becomes one generic line, because an
 * unexpected error's message is for a log, not for a stranger.
 */
export function messageFor(err: unknown): { message: string; status: number } {
  if (err instanceof FormError) return { message: err.message, status: err.status };
  const e = err as { status?: unknown; message?: unknown; name?: unknown } | null;
  if (e && e.name === 'AppError' && typeof e.status === 'number' && typeof e.message === 'string') {
    // A 500 from a service still carries a safe message by construction, but
    // there is no reason to show it: it is not actionable.
    return e.status >= 500
      ? { message: 'Something went wrong. Try again.', status: 500 }
      : { message: e.message, status: e.status };
  }
  return { message: 'Something went wrong. Try again.', status: 500 };
}
