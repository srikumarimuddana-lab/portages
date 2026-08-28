/**
 * MapKit JS token issuance.
 *
 * Apple requires the web client to present a JWT signed with your MapKit
 * private key (ES256 / ECDSA P-256). The private key must never reach the
 * browser, so the token is minted server-side and handed to the client with a
 * short lifetime.
 *
 * Two properties matter for security:
 *  - The `origin` claim binds the token to your domain, so a token scraped
 *    from your page cannot be replayed from someone else's site against your
 *    quota.
 *  - A short `exp` bounds the damage if one leaks. Tokens are cheap to mint;
 *    there is no reason to issue long-lived ones.
 *
 * Signing uses node:crypto only. Note that Node's `sign()` emits an ASN.1 DER
 * signature, while JOSE requires the raw r‖s concatenation — converting
 * between them is the one genuinely fiddly part, handled in derToJoseP256().
 */
import { createSign, createPrivateKey, type KeyObject } from 'node:crypto';

export interface MapKitKeyConfig {
  /** Apple Developer Team ID (10 chars), becomes the `iss` claim. */
  teamId: string;
  /** MapKit key identifier (10 chars), becomes the JWT header `kid`. */
  keyId: string;
  /** Contents of the .p8 private key file (PKCS#8 PEM). */
  privateKeyPem: string;
}

export interface TokenOptions {
  /** Exact origin the token is valid for, e.g. https://portage.ca */
  origin?: string | undefined;
  /** Lifetime in seconds. Kept short deliberately. */
  ttlSeconds?: number;
}

/** 30 minutes: long enough that clients rarely refresh, short enough to matter. */
export const DEFAULT_TTL_SECONDS = 30 * 60;
/** Apple rejects excessively long-lived tokens; refuse to mint one. */
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

const ID_RE = /^[A-Z0-9]{10}$/;

export class MapKitTokenIssuer {
  readonly #teamId: string;
  readonly #keyId: string;
  readonly #key: KeyObject;

  constructor(cfg: MapKitKeyConfig) {
    if (!ID_RE.test(cfg.teamId)) {
      throw new Error('MAPKIT_TEAM_ID must be 10 uppercase alphanumeric characters');
    }
    if (!ID_RE.test(cfg.keyId)) {
      throw new Error('MAPKIT_KEY_ID must be 10 uppercase alphanumeric characters');
    }
    // Throws on a malformed or non-EC key, at startup rather than per request.
    this.#key = createPrivateKey(cfg.privateKeyPem);
    if (this.#key.asymmetricKeyType !== 'ec') {
      throw new Error('MapKit private key must be an EC (P-256) key');
    }
    this.#teamId = cfg.teamId;
    this.#keyId = cfg.keyId;
  }

  issue(opts: TokenOptions = {}, now: number = Math.floor(Date.now() / 1000)): { token: string; expiresAt: number } {
    const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
      throw new Error(`MapKit token TTL must be between 1 and ${MAX_TTL_SECONDS} seconds`);
    }
    const exp = now + ttl;

    const header = { alg: 'ES256', kid: this.#keyId, typ: 'JWT' };
    const payload: Record<string, unknown> = { iss: this.#teamId, iat: now, exp };
    // Binds the token to one site. Omit only for local development.
    if (opts.origin) payload['origin'] = opts.origin;

    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const der = createSign('SHA256').update(signingInput).sign(this.#key);
    const jose = derToJoseP256(der);

    return { token: `${signingInput}.${jose.toString('base64url')}`, expiresAt: exp };
  }
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/**
 * Converts an ASN.1 DER ECDSA signature to the fixed-width r‖s form JOSE
 * requires (64 bytes for P-256).
 *
 * DER encodes r and s as signed big-endian integers, so it strips leading
 * zero bytes and may add one to keep the value positive. JOSE wants exactly
 * 32 bytes each, zero-padded on the left.
 */
export function derToJoseP256(der: Buffer): Buffer {
  const SIZE = 32;
  if (der.length < 8 || der[0] !== 0x30) {
    throw new Error('malformed DER signature');
  }
  // Skip SEQUENCE tag and length (short or long form).
  let offset = 1;
  const seqLen = der[1]!;
  offset += seqLen & 0x80 ? 1 + (seqLen & 0x7f) : 1;

  const readInt = (): Buffer => {
    if (der[offset] !== 0x02) throw new Error('malformed DER signature: expected INTEGER');
    offset += 1;
    const len = der[offset]!;
    offset += 1;
    const value = der.subarray(offset, offset + len);
    offset += len;
    // Strip the leading zero DER adds to keep the integer positive.
    let start = 0;
    while (start < value.length - 1 && value[start] === 0x00) start += 1;
    const trimmed = value.subarray(start);
    if (trimmed.length > SIZE) throw new Error('malformed DER signature: integer too large');
    const out = Buffer.alloc(SIZE);
    trimmed.copy(out, SIZE - trimmed.length); // left-pad
    return out;
  };

  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

/** Decodes a JWT's claims without verifying. For tests and debugging only. */
export function decodeUnverified(token: string): { header: unknown; payload: unknown } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  return {
    header: JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')),
  };
}
