/**
 * HTTP security headers and origin checks. Pure functions so they can be
 * asserted in tests and reused whether the transport is node:http, Fastify,
 * or Next.js route handlers.
 */

export interface HeaderOptions {
  /** Send HSTS. Only meaningful over TLS. */
  hsts: boolean;
  /** Extra origins permitted to load resources, e.g. an image CDN. */
  connectSrc?: string[];
}

/**
 * Content-Security-Policy for a JSON API. An API returns no HTML, so the
 * safest policy is to forbid essentially everything — this neutralizes any
 * reflected content that a browser might be tricked into rendering.
 */
export function apiSecurityHeaders(opts: HeaderOptions): Record<string, string> {
  const csp = [
    "default-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `connect-src 'self'${opts.connectSrc?.length ? ' ' + opts.connectSrc.join(' ') : ''}`,
  ].join('; ');

  const headers: Record<string, string> = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
    // Responses carry personal data; never let a shared cache hold them.
    'Cache-Control': 'no-store',
  };
  if (opts.hsts) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

/**
 * Headers for a document download. The combination matters: nosniff stops the
 * browser second-guessing the type, `attachment` stops inline rendering, and
 * the sandbox CSP neutralizes any script inside a crafted file.
 */
export function downloadHeaders(mime: string, filename: string, bytes: number): Record<string, string> {
  return {
    'Content-Type': mime,
    'Content-Length': String(bytes),
    'Content-Disposition': `attachment; filename="${filename}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
  };
}

/**
 * Strict origin allowlist. Returns the CORS headers, or null when the origin
 * is not permitted — in which case the caller must not add CORS headers at
 * all (silently omitting them is what makes the browser block the response).
 *
 * Note there is no wildcard branch: `Access-Control-Allow-Origin: *` cannot be
 * combined with credentials, and this API is cookie-authenticated.
 */
export function corsHeaders(origin: string | undefined, allowed: readonly string[]): Record<string, string> | null {
  if (!origin) return null;
  if (!allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-portage-csrf',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/**
 * Defence in depth alongside the CSRF token: for state-changing requests the
 * Origin header must be present and allowlisted. Browsers always send Origin
 * on cross-origin writes, so a missing Origin on a write is itself suspicious.
 */
export function originAllowedForWrite(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false;
  return allowed.includes(origin);
}

/** Maximum accepted JSON body. Unbounded bodies are a memory-exhaustion DoS. */
export const MAX_JSON_BYTES = 256 * 1024;

export function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  const type = header.split(';')[0]?.trim().toLowerCase();
  return type === 'application/json';
}
