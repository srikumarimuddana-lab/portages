/**
 * S3-compatible object storage.
 *
 * Written against the S3 API rather than any one vendor's SDK, which is what
 * keeps the choice reversible: Cloudflare R2, AWS S3, Backblaze B2 and
 * Supabase Storage all speak it. `docs/image-storage-strategy.md` recommends
 * R2, because egress — not storage — is the cost that grows with traffic, and
 * R2 charges nothing for it.
 *
 * Signing reuses `lib/awssig.ts`, already written and tested for SES. That is
 * the whole reason no SDK is needed here: S3 authentication is SigV4, and we
 * have SigV4.
 *
 * Bytes are not proxied through the server on the way IN — the browser PUTs
 * directly to a presigned URL. The server reads objects back only when it has
 * to, which is when metadata needs stripping.
 */
import { encodeS3Path, presignUrl, signRequest, type AwsCredentials } from '../../lib/awssig.js';

export interface S3Config {
  /** Bucket-scoped endpoint host, e.g. `<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  /** R2 uses `auto`; S3 uses the bucket's region. */
  region: string;
  credentials: AwsCredentials;
  /** Public base URL for reads, e.g. a CDN domain in front of the bucket. */
  publicBaseUrl?: string | undefined;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Uint8Array | string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export interface ObjectHead {
  contentLength: number;
  contentType: string | null;
  etag: string | null;
}

export class S3Storage {
  readonly #cfg: S3Config;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;

  constructor(cfg: S3Config) {
    this.#cfg = cfg;
    this.#fetch = cfg.fetchImpl ?? ((globalThis as unknown as { fetch: FetchLike }).fetch);
    this.#now = cfg.now ?? (() => new Date());
  }

  /** Path within the bucket-scoped endpoint. */
  #path(key: string): string {
    return `/${this.#cfg.bucket}${encodeS3Path(key)}`;
  }

  /**
   * A URL the browser can PUT bytes to, with no credential of ours in it.
   *
   * The signature covers the method and the key, so a URL issued for one
   * object cannot write another — which is what makes it safe to hand to a
   * client that we otherwise trust with nothing.
   *
   * `Content-Length` is deliberately NOT signed. Signing it would force the
   * browser to send exactly the byte count we predicted, and a client that
   * compresses before uploading cannot know it in advance. Size is enforced
   * on the completion path instead, where the real length is known.
   */
  presignPut(key: string, opts: { expiresIn?: number } = {}): string {
    return presignUrl({
      method: 'PUT',
      host: this.#cfg.endpoint,
      path: this.#path(key),
      expiresIn: opts.expiresIn ?? 900,
      service: 's3',
      region: this.#cfg.region,
      credentials: this.#cfg.credentials,
      now: this.#now(),
    });
  }

  /** A short-lived read URL, for private objects with no CDN in front. */
  presignGet(key: string, opts: { expiresIn?: number } = {}): string {
    return presignUrl({
      method: 'GET',
      host: this.#cfg.endpoint,
      path: this.#path(key),
      expiresIn: opts.expiresIn ?? 900,
      service: 's3',
      region: this.#cfg.region,
      credentials: this.#cfg.credentials,
      now: this.#now(),
    });
  }

  /** The permanent public URL, when the bucket sits behind a CDN domain. */
  publicUrl(key: string): string | null {
    if (!this.#cfg.publicBaseUrl) return null;
    return `${this.#cfg.publicBaseUrl.replace(/\/+$/, '')}${encodeS3Path(key)}`;
  }

  /**
   * Metadata without the body.
   *
   * This is how the completion path confirms an upload actually happened and
   * learns its real size — the size a client claimed at ticket time is a
   * guess, and the size it claims afterwards is a claim.
   */
  async head(key: string): Promise<ObjectHead | null> {
    const res = await this.#send('HEAD', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage HEAD failed: ${res.status}`);
    return {
      contentLength: Number(res.headers.get('content-length') ?? 0),
      contentType: res.headers.get('content-type'),
      etag: res.headers.get('etag'),
    };
  }

  /**
   * Reads an object, optionally just the first `maxBytes`.
   *
   * The range form is what keeps metadata checking cheap: a few kilobytes is
   * enough to tell whether a file carries EXIF, so a full download only
   * happens for the files that actually need rewriting.
   */
  async get(key: string, opts: { maxBytes?: number } = {}): Promise<Uint8Array | null> {
    const headers: Record<string, string> = {};
    if (opts.maxBytes !== undefined) headers['range'] = `bytes=0-${opts.maxBytes - 1}`;

    const res = await this.#send('GET', key, { headers });
    if (res.status === 404) return null;
    // 206 Partial Content is the success case for a range request.
    if (!res.ok && res.status !== 206) throw new Error(`storage GET failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const res = await this.#send('PUT', key, {
      body,
      headers: { 'content-type': contentType },
    });
    if (!res.ok) throw new Error(`storage PUT failed: ${res.status}`);
  }

  async delete(key: string): Promise<void> {
    const res = await this.#send('DELETE', key);
    // 204 on success, 404 when it was already gone — both are the outcome the
    // caller wanted, so neither is an error.
    if (!res.ok && res.status !== 404) throw new Error(`storage DELETE failed: ${res.status}`);
  }

  async #send(
    method: string,
    key: string,
    opts: { body?: Uint8Array; headers?: Record<string, string> } = {},
  ) {
    const signed = signRequest({
      method,
      host: this.#cfg.endpoint,
      path: this.#path(key),
      service: 's3',
      region: this.#cfg.region,
      credentials: this.#cfg.credentials,
      headers: opts.headers ?? {},
      // A binary body cannot be hashed as a string, so uploads declare
      // UNSIGNED-PAYLOAD. It has to be declared at signing time, not patched
      // in afterwards — the hash is itself a signed header.
      ...(opts.body ? { payloadHash: 'UNSIGNED-PAYLOAD' } : {}),
      now: this.#now(),
    });

    return this.#fetch(signed.url, {
      method,
      headers: signed.headers,
      ...(opts.body ? { body: opts.body } : {}),
    });
  }
}
