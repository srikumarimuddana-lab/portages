/**
 * JWT verification for OAuth `id_token`s.
 *
 * This is the security boundary of social login. If it is wrong, anyone can
 * mint a token asserting they are any user. The rules it enforces:
 *
 *  - The signature is verified against the provider's published JWKS. An
 *    unverified token is never parsed for claims.
 *  - `alg` comes from OUR allowlist, never from the token header. Trusting
 *    the header is the classic algorithm-confusion attack: `alg: "none"`, or
 *    swapping RS256 for HS256 so the public key is used as an HMAC secret.
 *  - `iss`, `aud`, `exp`, `iat` and `nonce` are all checked. A signature
 *    proves origin, not intent — a token minted for a different application
 *    is perfectly valid and completely unacceptable.
 *
 * Deliberately no third-party JWT library: this is small, and the library
 * CVEs in this space are almost all in exactly the checks above.
 */
import { createPublicKey, createVerify, timingSafeEqual, type KeyObject } from 'node:crypto';

/** Signature algorithms we accept. Symmetric algorithms are absent on purpose. */
const ALLOWED_ALGS = new Set(['RS256', 'ES256']);

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  [key: string]: unknown;
}

export interface VerifyOptions {
  /** Exact issuer(s) we accept. */
  issuer: string | string[];
  /** Our client id. The token must be addressed to us. */
  audience: string;
  /** The nonce we generated for this authorization request. */
  nonce?: string | undefined;
  /** Clock skew tolerance in seconds. */
  clockToleranceSec?: number;
  now?: number;
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

/**
 * Verifies an id_token and returns its claims.
 * Throws JwtError on any failure — never returns partially-validated claims.
 */
export function verifyIdToken(token: string, jwks: Jwk[], opts: VerifyOptions): IdTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('token is not a JWT');
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = decodeSegment<JwtHeader>(headerB64, 'header');

  // Algorithm confusion guard: the token does not get to choose.
  if (!ALLOWED_ALGS.has(header.alg)) {
    throw new JwtError(`unsupported algorithm: ${header.alg}`);
  }

  const key = selectKey(jwks, header);
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(sigB64, 'base64url');

  if (!verifySignature(header.alg, signingInput, signature, key)) {
    throw new JwtError('signature verification failed');
  }

  // Only now is the payload trustworthy enough to read.
  const claims = decodeSegment<IdTokenClaims>(payloadB64, 'payload');
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.clockToleranceSec ?? 60;

  const issuers = Array.isArray(opts.issuer) ? opts.issuer : [opts.issuer];
  if (typeof claims.iss !== 'string' || !issuers.includes(claims.iss)) {
    throw new JwtError('issuer mismatch');
  }

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.some((a) => typeof a === 'string' && constantTimeEquals(a, opts.audience))) {
    throw new JwtError('audience mismatch');
  }

  if (typeof claims.exp !== 'number' || claims.exp + skew < now) {
    throw new JwtError('token expired');
  }
  if (typeof claims.iat !== 'number' || claims.iat - skew > now) {
    throw new JwtError('token issued in the future');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new JwtError('missing subject');
  }

  // Replay guard: the nonce ties this token to the authorization request we
  // started. Absent when we did not send one.
  if (opts.nonce !== undefined) {
    if (typeof claims.nonce !== 'string' || !constantTimeEquals(claims.nonce, opts.nonce)) {
      throw new JwtError('nonce mismatch');
    }
  }

  return claims;
}

/**
 * Providers publish `email_verified` inconsistently — Google sends a boolean,
 * some send the string "true". Anything else is treated as NOT verified,
 * because this single value gates account linking.
 */
export function isEmailVerified(claims: IdTokenClaims): boolean {
  const v = claims.email_verified;
  return v === true || v === 'true';
}

function selectKey(jwks: Jwk[], header: JwtHeader): KeyObject {
  const candidates = header.kid
    ? jwks.filter((k) => k.kid === header.kid)
    : jwks;
  if (candidates.length === 0) throw new JwtError('no matching key in JWKS');

  // With a kid there is exactly one key; without one, try each and let the
  // signature decide. Never fall back to a key whose declared alg conflicts.
  for (const jwk of candidates) {
    if (jwk.alg && jwk.alg !== header.alg) continue;
    try {
      return createPublicKey({ key: jwk as never, format: 'jwk' });
    } catch {
      continue;
    }
  }
  throw new JwtError('no usable key in JWKS');
}

function verifySignature(alg: string, input: string, signature: Buffer, key: KeyObject): boolean {
  try {
    if (alg === 'RS256') {
      return createVerify('SHA256').update(input).verify(key, signature);
    }
    // ES256 signatures arrive as raw r‖s; Node's verifier expects DER unless
    // told otherwise.
    if (alg === 'ES256') {
      if (signature.length !== 64) return false;
      return createVerify('SHA256')
        .update(input)
        .verify({ key, dsaEncoding: 'ieee-p1363' } as never, signature);
    }
    return false;
  } catch {
    return false;
  }
}

function decodeSegment<T>(segment: string, what: string): T {
  let json: string;
  try {
    json = Buffer.from(segment, 'base64url').toString('utf8');
  } catch {
    throw new JwtError(`${what} is not valid base64url`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new JwtError(`${what} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new JwtError(`${what} is not an object`);
  }
  return parsed as T;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Fetches and caches a provider's JWKS.
 *
 * Providers rotate keys, so a permanent cache breaks logins; refetching per
 * request hands the provider a denial-of-service lever over our login flow.
 * A short TTL plus a single refetch on an unknown `kid` covers both.
 */
export class JwksCache {
  readonly #url: string;
  readonly #ttlMs: number;
  readonly #fetch: typeof fetch;
  #keys: Jwk[] = [];
  #fetchedAt = 0;
  #inflight: Promise<Jwk[]> | null = null;

  constructor(url: string, opts: { ttlMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.#url = url;
    this.#ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async get(kid?: string, now = Date.now()): Promise<Jwk[]> {
    const fresh = now - this.#fetchedAt < this.#ttlMs;
    const hasKid = !kid || this.#keys.some((k) => k.kid === kid);
    if (fresh && hasKid && this.#keys.length > 0) return this.#keys;
    return this.#refresh();
  }

  async #refresh(): Promise<Jwk[]> {
    // Collapse concurrent refreshes into one request.
    this.#inflight ??= (async () => {
      try {
        const res = await this.#fetch(this.#url, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new JwtError(`JWKS fetch failed: ${res.status}`);
        const body = (await res.json()) as { keys?: Jwk[] };
        if (!Array.isArray(body.keys) || body.keys.length === 0) {
          throw new JwtError('JWKS contained no keys');
        }
        this.#keys = body.keys;
        this.#fetchedAt = Date.now();
        return this.#keys;
      } finally {
        this.#inflight = null;
      }
    })();
    return this.#inflight;
  }
}
