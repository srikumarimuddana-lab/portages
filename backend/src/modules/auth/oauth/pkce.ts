/**
 * PKCE and authorization-request state.
 *
 * Pure functions so the security properties can be tested without a database
 * or a provider. Three separate random values, each with a distinct job:
 *
 *   state     ties the callback to a request we started (CSRF on the redirect)
 *   verifier  proves the client completing the exchange is the one that
 *             started it (defeats authorization-code interception)
 *   nonce     ties the returned id_token to this request (replay protection)
 */
import { createHash } from 'node:crypto';
import { generateToken, hashToken } from '../../../lib/crypto.js';

export interface AuthRequestMaterial {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  nonce: string;
  /** Stored server-side; the raw verifier and nonce never hit the database. */
  codeChallengeHash: Buffer;
  nonceHash: Buffer;
  expiresAt: Date;
}

/** Authorization requests are short-lived; a login does not take 10 minutes. */
export const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

export function createAuthRequest(now: Date = new Date()): AuthRequestMaterial {
  const codeVerifier = generateToken(32);
  const nonce = generateToken(16);
  const codeChallenge = s256(codeVerifier);
  return {
    state: generateToken(32),
    codeVerifier,
    codeChallenge,
    nonce,
    codeChallengeHash: hashToken(codeChallenge),
    nonceHash: hashToken(nonce),
    expiresAt: new Date(now.getTime() + AUTH_REQUEST_TTL_MS),
  };
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function verifierMatches(verifier: string, challenge: string): boolean {
  return s256(verifier) === challenge;
}

/**
 * Validates the post-login redirect target.
 *
 * Only same-site absolute paths are permitted. An open redirect on a login
 * callback is a phishing primitive: the attacker gets your domain in the
 * address bar and your users' trust.
 */
export function safeRedirectPath(input: string | null | undefined, fallback = '/'): string {
  if (!input) return fallback;
  // Must start with a single slash. "//evil.com" is protocol-relative, and
  // "/\evil.com" is treated as protocol-relative by some browsers.
  if (!input.startsWith('/')) return fallback;
  if (input.startsWith('//') || input.startsWith('/\\')) return fallback;
  if (input.includes('://')) return fallback;
  // Control characters and whitespace can smuggle past naive checks.
  if (/[\u0000-\u0020\u007F]/.test(input)) return fallback;
  if (input.length > 512) return fallback;
  return input;
}

export interface AuthorizeUrlParams {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  nonce: string;
}

export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: p.scope,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
    nonce: p.nonce,
    // Force account selection rather than silently reusing a session the
    // browser already has — surprising auto-login is a support burden.
    prompt: 'select_account',
  });
  return `${p.authorizeUrl}?${q.toString()}`;
}
