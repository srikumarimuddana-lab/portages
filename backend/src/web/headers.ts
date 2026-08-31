/**
 * Response headers for HTML pages.
 *
 * Here rather than duplicated across the two route files because the Content
 * Security Policy is a security control, and a control that exists in two
 * copies is a control that will one day exist in two versions.
 */

/**
 * The page CSP.
 *
 * `img-src https:` is wide because photos are served from a CDN whose domain
 * is deployment configuration, and a redirect from /media/:key can land on
 * either the CDN or a presigned bucket URL.
 *
 * `connect-src` IS THE ONE THAT MATTERS HERE. Photo uploads PUT straight from
 * the browser to object storage — the bytes never pass through this server —
 * so the bucket's own origin has to be allowed or the browser blocks the
 * request before it is sent. Without it the uploader fails with nothing in the
 * network log and a console error the owner will never see. It is added only
 * for the signed-in surface, and only for the exact origin configured, so a
 * public page still cannot talk to anything but us.
 *
 * 'unsafe-inline' is present for styles and the two small inline scripts.
 * Tightening it to a nonce is the next step, not a different design.
 */
export function contentSecurityPolicy(opts: { uploadOrigin?: string | null } = {}): string {
  const connect = opts.uploadOrigin ? `'self' ${opts.uploadOrigin}` : "'self'";
  return [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    `connect-src ${connect}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * The origin the browser is allowed to PUT photo bytes to, or null when
 * object storage is not configured — in which case there is nothing to allow
 * and the policy stays at 'self'.
 *
 * Only the ORIGIN goes into the policy, never the presigned URL: that URL
 * carries a signature, and a signature does not belong in a response header
 * that is logged, cached, and sent on every page load.
 */
export function uploadOriginOf(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(`https://${endpoint.replace(/^https?:\/\//, '')}`).origin;
  } catch {
    return null;
  }
}
