/**
 * Session and CSRF logic, framework-agnostic and side-effect free so it can be
 * unit-tested without a server or a database.
 *
 * Threat model addressed:
 *  - Stolen database dump  -> only digests are stored; tokens are unusable.
 *  - Stolen cookie          -> idle + absolute expiry bound the window.
 *  - Session fixation       -> a new token is minted on every login.
 *  - CSRF                   -> double-submit: cookie value must match a header
 *                              value, which a cross-origin page cannot read.
 *  - XSS reading the cookie -> HttpOnly.
 */
import { generateToken, hashToken, timingSafeEqualStrings } from './crypto.js';

/** 30 minutes of inactivity ends a session. */
export const IDLE_TTL_MS = 30 * 60 * 1000;
/** A session cannot outlive 14 days regardless of activity. */
export const ABSOLUTE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = '__Host-portage_session';
export const CSRF_COOKIE = '__Host-portage_csrf';
export const CSRF_HEADER = 'x-portage-csrf';

export interface NewSessionMaterial {
  sessionToken: string;
  csrfToken: string;
  tokenHash: Buffer;
  csrfHash: Buffer;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export function createSessionMaterial(now: Date = new Date()): NewSessionMaterial {
  const sessionToken = generateToken(32);
  const csrfToken = generateToken(32);
  return {
    sessionToken,
    csrfToken,
    tokenHash: hashToken(sessionToken),
    csrfHash: hashToken(csrfToken),
    idleExpiresAt: new Date(now.getTime() + IDLE_TTL_MS),
    absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_TTL_MS),
  };
}

export interface StoredSession {
  id: string;
  userId: string;
  csrfHash: Buffer;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

export type SessionCheck =
  | { valid: true; userId: string; renewIdleTo: Date }
  | { valid: false; reason: 'revoked' | 'idle_expired' | 'absolute_expired' };

export function checkSession(s: StoredSession, now: Date = new Date()): SessionCheck {
  if (s.revokedAt) return { valid: false, reason: 'revoked' };
  if (now >= s.absoluteExpiresAt) return { valid: false, reason: 'absolute_expired' };
  if (now >= s.idleExpiresAt) return { valid: false, reason: 'idle_expired' };
  // Sliding idle window, never past the absolute ceiling.
  const renew = new Date(Math.min(now.getTime() + IDLE_TTL_MS, s.absoluteExpiresAt.getTime()));
  return { valid: true, userId: s.userId, renewIdleTo: renew };
}

/** Methods that cannot change state and therefore need no CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requiresCsrf(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Double-submit check. Both halves must be present and equal, and the
 * presented value must match the digest stored server-side — so an attacker
 * who can set cookies (subdomain injection) still cannot forge a request.
 */
export function verifyCsrf(
  headerValue: string | undefined,
  cookieValue: string | undefined,
  storedHash: Buffer,
): boolean {
  if (!headerValue || !cookieValue) return false;
  if (!timingSafeEqualStrings(headerValue, cookieValue)) return false;
  const presented = hashToken(headerValue);
  if (presented.length !== storedHash.length) return false;
  return timingSafeEqualStrings(presented.toString('hex'), storedHash.toString('hex'));
}

export interface CookieOptions {
  secure: boolean;
  maxAgeMs: number;
}

/**
 * Serializes a cookie with the hardened defaults. The `__Host-` prefix is not
 * decorative: browsers refuse a `__Host-` cookie unless it is Secure, Path=/,
 * and has no Domain — which blocks subdomain cookie-injection attacks.
 */
export function serializeCookie(
  name: string,
  value: string,
  opts: CookieOptions & { httpOnly?: boolean },
): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`,
  ];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name: string, secure: boolean): string {
  const parts = [`${name}=`, 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!header) return out;
  for (const piece of header.split(';')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const k = piece.slice(0, eq).trim();
    const v = piece.slice(eq + 1).trim();
    if (!k || k === '__proto__') continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}
