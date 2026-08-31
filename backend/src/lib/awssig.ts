/**
 * AWS Signature Version 4.
 *
 * Implemented here rather than pulled in, for the same reason as the rest of
 * this codebase: `npm install @aws-sdk/client-sesv2` drags in a large
 * dependency tree for what is, at the volume Portage sends, two HTTP calls.
 * SigV4 is a precisely specified algorithm and AWS publishes test vectors, so
 * it is verifiable rather than hopeful.
 *
 * If you would rather use the official SDK, the channel implementations in
 * modules/notify/channels/ are the only callers — swapping is contained.
 *
 * Reference: docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4-signing.html
 */
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

export interface SignRequestParams {
  method: string;
  /** Host only, e.g. email.ca-central-1.amazonaws.com */
  host: string;
  /** Absolute path, e.g. /v2/email/outbound-emails */
  path: string;
  /** Already-encoded query string without the leading '?'. */
  query?: string;
  headers?: Record<string, string>;
  body?: string;
  service: string;
  region: string;
  credentials: AwsCredentials;
  /**
   * Overrides the computed body hash — pass `UNSIGNED-PAYLOAD` for a binary
   * upload whose bytes are not a string.
   *
   * It must be set HERE rather than patched into the headers afterwards: the
   * hash appears both in the canonical request and in the signed
   * `x-amz-content-sha256` header, so changing one after signing produces a
   * signature over a value the request does not send, and S3 rejects it with
   * a SignatureDoesNotMatch that looks like a credentials fault.
   */
  payloadHash?: string;
  /** Injectable for deterministic tests. */
  now?: Date;
}

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';

export function signRequest(p: SignRequestParams): SignedRequest {
  const now = p.now ?? new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const body = p.body ?? '';
  const payloadHash = p.payloadHash ?? sha256Hex(body);

  // Host and x-amz-date must be signed; AWS rejects requests without them.
  const headers: Record<string, string> = {
    host: p.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...lowercaseKeys(p.headers ?? {}),
  };
  if (p.credentials.sessionToken) {
    headers['x-amz-security-token'] = p.credentials.sessionToken;
  }

  // Canonical headers are sorted by name, values trimmed and inner runs of
  // whitespace collapsed. Getting this wrong is the usual cause of a
  // SignatureDoesNotMatch that looks like a credentials problem.
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames
    .map((n) => `${n}:${collapseWhitespace(headers[n]!)}\n`)
    .join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    p.method.toUpperCase(),
    p.path || '/',
    p.query ?? '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${p.region}/${p.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(
    p.credentials.secretAccessKey,
    dateStamp,
    p.region,
    p.service,
  );
  const signature = hmac(signingKey, stringToSign).toString('hex');

  headers['authorization'] =
    `${ALGORITHM} Credential=${p.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${p.host}${p.path || '/'}${p.query ? `?${p.query}` : ''}`;
  return { url, method: p.method.toUpperCase(), headers, body };
}

export interface PresignParams {
  method: string;
  host: string;
  path: string;
  /** Seconds the URL stays valid. AWS caps this at 7 days. */
  expiresIn: number;
  service: string;
  region: string;
  credentials: AwsCredentials;
  /** Extra query parameters to include in the signature. */
  query?: Record<string, string>;
  now?: Date;
}

const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

/**
 * Builds a presigned URL — SigV4 carried in the query string rather than an
 * Authorization header.
 *
 * This is what lets a browser upload bytes straight to object storage without
 * them passing through our server, and without the browser ever seeing a
 * credential. The signature covers the method, the key, and the expiry, so a
 * URL minted for a PUT to one key cannot be used to write another.
 *
 * The payload hash is the literal `UNSIGNED-PAYLOAD`: the signer does not have
 * the bytes, and requiring their hash up front would mean reading the whole
 * file into the server first, which is the thing this avoids.
 */
export function presignUrl(p: PresignParams): string {
  const now = p.now ?? new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const expiresIn = Math.min(Math.max(Math.trunc(p.expiresIn), 1), MAX_PRESIGN_SECONDS);
  const credentialScope = `${dateStamp}/${p.region}/${p.service}/aws4_request`;

  // Only `host` is signed. Signing more would require the browser to send
  // exactly those headers, and a mismatch fails with an error that reads like
  // a credentials problem rather than a header problem.
  const params: Record<string, string> = {
    ...(p.query ?? {}),
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${p.credentials.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  if (p.credentials.sessionToken) {
    params['X-Amz-Security-Token'] = p.credentials.sessionToken;
  }

  // Canonical query: sorted by key, RFC 3986 encoded. Sorting is by the
  // ENCODED key, which matters as soon as a key contains a character that
  // encodes to something ordering differently.
  const canonicalQuery = Object.keys(params)
    .map((k) => [rfc3986(k), rfc3986(params[k]!)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    p.method.toUpperCase(),
    p.path || '/',
    canonicalQuery,
    `host:${p.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(
    p.credentials.secretAccessKey, dateStamp, p.region, p.service,
  );
  const signature = hmac(signingKey, stringToSign).toString('hex');

  return `https://${p.host}${p.path || '/'}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * Percent-encodes an object key for use as a URL path.
 *
 * `/` must survive as a path separator — keys are hierarchical — while every
 * other character is encoded. `encodeURIComponent` on the whole key would turn
 * the separators into %2F and address a different object.
 */
export function encodeS3Path(key: string): string {
  return `/${key.split('/').map(rfc3986).join('/')}`;
}

/**
 * The four-step key derivation. Each step keys the next, so a leaked signing
 * key is scoped to one date, region and service rather than the whole account.
 */
function deriveSigningKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(Buffer.from(`AWS4${secret}`, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** YYYYMMDD'T'HHMMSS'Z' */
export function toAmzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function collapseWhitespace(v: string): string {
  return v.trim().replace(/\s+/g, ' ');
}

function lowercaseKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Form-encodes a body the way AWS query APIs expect: sorted keys, and
 * RFC 3986 encoding (encodeURIComponent leaves !'()* alone, which AWS does
 * not accept in signed content).
 */
export function formEncode(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k]!)}`)
    .join('&');
}

export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
