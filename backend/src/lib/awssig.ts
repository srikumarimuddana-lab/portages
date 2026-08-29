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
  const payloadHash = sha256Hex(body);

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
