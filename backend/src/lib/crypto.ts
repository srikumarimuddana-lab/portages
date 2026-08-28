/**
 * Security primitives. Node built-ins only — no third-party crypto.
 *
 * Design rules enforced here:
 *  - Passwords are never stored or compared in plaintext.
 *  - Session and CSRF tokens are stored only as SHA-256 digests, so a
 *    database leak does not hand an attacker usable credentials.
 *  - Every secret comparison is timing-safe.
 *  - Signed URLs are HMAC-authenticated and expiring; they are not secrets
 *    that live forever in someone's browser history.
 */
import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
  createHmac,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt parameters. OWASP's floor for scrypt is N=2^17, r=8, p=1; we default
 * to 2^16 to keep login latency acceptable on small instances and expose N so
 * it can be raised without a code change. argon2id would be the first choice
 * but requires a native module — scrypt is the strongest option available
 * from the standard library alone.
 */
export const SCRYPT_N = 1 << 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
// scrypt needs roughly 128 * N * r bytes; give it headroom or Node throws.
const maxmemFor = (n: number) => 256 * n * SCRYPT_R;

/** Encoded as scrypt$N$r$p$salt_b64$hash_b64 so parameters can evolve. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password required');
  }
  const salt = randomBytes(SALT_LEN);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: maxmemFor(SCRYPT_N),
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

/**
 * Verifies a password. Returns false rather than throwing on a malformed
 * stored hash, so a corrupted row cannot be distinguished from a wrong
 * password by an attacker watching responses.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (N <= 0 || (N & (N - 1)) !== 0) return false; // N must be a power of two
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N),
    });
    return timingSafeEqualBuffers(actual, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash was produced with weaker parameters than current. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < SCRYPT_N;
}

/** Length-independent, timing-safe buffer comparison. */
export function timingSafeEqualBuffers(a: Buffer, b: Buffer): boolean {
  // timingSafeEqual throws on length mismatch, which itself leaks length.
  // Compare digests of equal size instead so the code path is uniform.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Timing-safe comparison of two strings (tokens, signatures). */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  return timingSafeEqualBuffers(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** 256 bits of CSPRNG entropy, URL-safe. Used for session and CSRF tokens. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** What we persist for a token. The token itself is never written to disk. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Keyed hash for pseudonymous analytics and IP logging. Using a server-side
 * pepper means the stored value cannot be reversed by rainbow table, and
 * rotating the pepper severs the link entirely.
 */
export function pseudonymize(value: string, pepper: string): Buffer {
  return createHmac('sha256', pepper).update(value, 'utf8').digest();
}

export interface SignedUrlParams {
  storageKey: string;
  userId: string;
  expiresAt: number; // epoch seconds
}

/**
 * Signs a storage reference. The signature binds the object key, the user it
 * was issued to, and an expiry — so a leaked URL cannot be replayed by a
 * different account or used after it expires.
 */
export function signStorageUrl(params: SignedUrlParams, secret: string): string {
  const payload = canonicalPayload(params);
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`;
}

export function verifyStorageUrl(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): SignedUrlParams | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!timingSafeEqualStrings(sig, expected)) return null;

  const parts = payload.split('\n');
  if (parts.length !== 3) return null;
  const [storageKey, userId, expStr] = parts as [string, string, string];
  const expiresAt = Number(expStr);
  if (!Number.isInteger(expiresAt) || expiresAt <= now) return null;
  return { storageKey, userId, expiresAt };
}

function canonicalPayload(p: SignedUrlParams): string {
  // Newline-delimited and order-fixed: no ambiguity an attacker could exploit
  // by shifting characters between fields.
  if (p.storageKey.includes('\n') || p.userId.includes('\n')) {
    throw new Error('illegal character in signed payload');
  }
  return `${p.storageKey}\n${p.userId}\n${p.expiresAt}`;
}
