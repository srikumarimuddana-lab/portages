/**
 * The upload lifecycle.
 *
 * An upload has three steps, and the middle one does not involve this server:
 *
 *   1. TICKET   — we reserve a key, record what the client claims it is
 *                 about to send, and hand back a presigned PUT URL plus a
 *                 completion token bound to the key and the user.
 *   2. PUT      — the browser sends the bytes straight to object storage.
 *   3. COMPLETE — the client tells us it finished; we read the object back
 *                 and decide whether to believe it.
 *
 * Everything the client says in step 1 is a claim. The size, the type, and
 * whether the file is an image at all are established in step 3 by reading
 * bytes, because a Content-Type header is chosen by whoever sends it.
 *
 * Step 3 is also where metadata comes off. Browser-side compression re-encodes
 * through a canvas and drops EXIF as a side effect, so most files arrive clean
 * — which is why completion first reads only the head of the object and stops
 * there when it finds nothing. A full download and rewrite happens only for
 * the files that actually carry metadata.
 */
import { createHash, randomUUID } from 'node:crypto';
import { hasMetadata, mimeFor, sniffImage, stripMetadata, RENDERABLE } from './imagemeta.js';
import type { S3Storage } from './s3.js';
import { signStorageUrl, verifyStorageUrl } from '../../lib/crypto.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import type { Sql } from '../../db/pool.js';

export type UploadSubject = 'listing_media' | 'document';

/** How long a presigned PUT and its completion token stay usable. */
export const UPLOAD_TTL_SEC = 900;
/** Bytes read back to decide whether a rewrite is needed. */
export const HEAD_PROBE_BYTES = 64 * 1024;
/** Hard ceiling on a file the server will pull down to rewrite. */
export const MAX_REWRITE_BYTES = 25 * 1024 * 1024;

export interface TicketInput {
  ownerId: string;
  subjectType: UploadSubject;
  subjectId: string;
  storageKey: string;
  mime: string;
  bytes: number;
}

export interface UploadTicket {
  uploadId: string;
  storageKey: string;
  /** PUT the bytes here. Carries no credential of ours. */
  uploadUrl: string;
  /** Present this to /api/uploads/complete afterwards. */
  completionToken: string;
  expiresAt: number;
}

export type CompletionOutcome =
  | {
      ok: true;
      uploadId: string;
      subjectType: UploadSubject;
      subjectId: string;
      bytes: number;
      mime: string;
      contentHash: string;
      metadataStripped: string[];
      orientation: number | null;
      hadGps: boolean;
    }
  | { ok: false; reason: string };

export interface StorageDeps {
  db: Sql;
  storage: S3Storage;
  ticketSecret: string;
  now?: () => Date;
}

export class UploadService {
  readonly #db: Sql;
  readonly #storage: S3Storage;
  readonly #secret: string;
  readonly #now: () => Date;

  constructor(deps: StorageDeps) {
    this.#db = deps.db;
    this.#storage = deps.storage;
    this.#secret = deps.ticketSecret;
    this.#now = deps.now ?? (() => new Date());
  }

  /** Reserves a key and returns somewhere to send the bytes. */
  async ticket(input: TicketInput): Promise<UploadTicket> {
    const uploadId = randomUUID();
    const expiresAt = Math.floor(this.#now().getTime() / 1000) + UPLOAD_TTL_SEC;

    await this.#db.query(
      `INSERT INTO uploads
         (id, owner_id, subject_type, subject_id, storage_key,
          declared_mime, declared_bytes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8))`,
      [
        uploadId, input.ownerId, input.subjectType, input.subjectId,
        input.storageKey, input.mime, input.bytes, expiresAt,
      ],
    );

    return {
      uploadId,
      storageKey: input.storageKey,
      uploadUrl: this.#storage.presignPut(input.storageKey, { expiresIn: UPLOAD_TTL_SEC }),
      // Bound to the key AND the user, so a leaked token cannot complete a
      // different upload or be redeemed by another account.
      completionToken: signStorageUrl(
        { storageKey: input.storageKey, userId: input.ownerId, expiresAt },
        this.#secret,
      ),
      expiresAt,
    };
  }

  /**
   * Verifies an upload actually happened and that the bytes are what they
   * were said to be.
   *
   * Everything checked here is checked because the alternative is trusting the
   * client: that the object exists, how big it really is, what it really is,
   * and whether it still carries the photographer's GPS coordinates.
   */
  async complete(input: { token: string; ownerId: string }): Promise<CompletionOutcome> {
    const ticket = verifyStorageUrl(input.token, this.#secret);
    if (!ticket) return { ok: false, reason: 'The upload link has expired. Start again.' };
    // The token carries the user it was minted for; the session says who is
    // presenting it. A mismatch means a token was passed between accounts.
    if (ticket.userId !== input.ownerId) {
      return { ok: false, reason: 'The upload link has expired. Start again.' };
    }

    const { rows } = await this.#db.query<{
      id: string; owner_id: string; subject_type: UploadSubject; subject_id: string;
      storage_key: string; status: string; declared_bytes: string; declared_mime: string;
    }>(
      `SELECT id, owner_id, subject_type, subject_id, storage_key, status,
              declared_bytes, declared_mime
         FROM uploads WHERE storage_key = $1`,
      [ticket.storageKey],
    );
    const row = rows[0];
    if (!row || row.owner_id !== input.ownerId) throw notFound('Upload not found.');
    if (row.status === 'stored') {
      // Completing twice is a retry, not an error — the network is unreliable
      // and the client cannot always tell whether its first call landed.
      return this.#alreadyStored(row.id);
    }

    const head = await this.#storage.head(ticket.storageKey);
    if (!head) {
      return { ok: false, reason: 'No file was received. Try uploading again.' };
    }
    if (head.contentLength <= 0) {
      await this.#reject(row.id, 'empty');
      return { ok: false, reason: 'The uploaded file is empty.' };
    }
    if (head.contentLength > MAX_REWRITE_BYTES) {
      await this.#reject(row.id, 'too_large');
      await this.#storage.delete(ticket.storageKey);
      return { ok: false, reason: 'The uploaded file is larger than the limit.' };
    }

    const isImage = row.subject_type === 'listing_media';
    let bytesForHash: Uint8Array | null = null;
    let stripped: string[] = [];
    let orientation: number | null = null;
    let hadGps = false;
    let mime = row.declared_mime;

    if (isImage) {
      const probe = await this.#storage.get(ticket.storageKey, { maxBytes: HEAD_PROBE_BYTES });
      if (!probe || probe.length === 0) {
        return { ok: false, reason: 'No file was received. Try uploading again.' };
      }

      // What it IS, not what it claimed to be. A file announced as
      // image/jpeg that begins "<svg onload=" is the oldest trick there is.
      const kind = sniffImage(probe);
      const sniffedMime = mimeFor(kind);
      if (!sniffedMime) {
        await this.#reject(row.id, 'not_an_image');
        await this.#storage.delete(ticket.storageKey);
        return { ok: false, reason: 'That file is not an image we recognize.' };
      }
      mime = sniffedMime;

      if (hasMetadata(probe)) {
        // Only now is the whole object worth pulling down.
        const full = await this.#storage.get(ticket.storageKey);
        if (!full) return { ok: false, reason: 'No file was received. Try uploading again.' };

        const result = stripMetadata(full);
        stripped = result.removed;
        orientation = result.orientation;
        hadGps = result.hadGps;

        if (result.changed) {
          await this.#storage.put(ticket.storageKey, result.bytes, mime);
          bytesForHash = result.bytes;
        } else {
          bytesForHash = full;
        }
      }
    }

    // The hash is over what is actually stored. Computing it over the
    // pre-strip bytes would give a digest of a file that no longer exists.
    const finalBytes = bytesForHash ?? (await this.#storage.get(ticket.storageKey));
    if (!finalBytes) return { ok: false, reason: 'No file was received. Try uploading again.' };
    const contentHash = createHash('sha256').update(finalBytes).digest();

    await this.#db.transaction(async (tx) => {
      await tx.query(
        `UPDATE uploads
            SET status = 'stored', verified_mime = $2, verified_bytes = $3,
                content_hash = $4, metadata_stripped = $5, had_gps = $6,
                exif_orientation = $7, completed_at = now()
          WHERE id = $1`,
        [row.id, mime, finalBytes.length, contentHash, stripped, hadGps, orientation],
      );

      if (row.subject_type === 'listing_media') {
        await tx.query(
          `UPDATE listing_media
              SET status = 'stored', mime = $2, bytes = $3, orientation = $4
            WHERE id = $1`,
          [row.subject_id, mime, finalBytes.length, orientation],
        );
      } else {
        await tx.query(
          `UPDATE documents SET status = 'stored', bytes = $2, content_hash = $3
            WHERE id = $1`,
          [row.subject_id, finalBytes.length, contentHash],
        );
      }
    });

    return {
      ok: true,
      uploadId: row.id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      bytes: finalBytes.length,
      mime,
      contentHash: contentHash.toString('hex'),
      metadataStripped: stripped,
      orientation,
      hadGps,
    };
  }

  /** Records the browser-computed blur placeholder and intrinsic dimensions. */
  async recordPreview(input: {
    mediaId: string;
    ownerId: string;
    blurhash?: string | undefined;
    width?: number | undefined;
    height?: number | undefined;
  }): Promise<void> {
    if (input.blurhash && input.blurhash.length > 64) {
      throw badRequest('Blur placeholder is too long.');
    }
    const res = await this.#db.query(
      `UPDATE listing_media m
          SET blurhash = COALESCE($3, m.blurhash),
              width    = COALESCE($4, m.width),
              height   = COALESCE($5, m.height)
         FROM listings l
        WHERE m.listing_id = l.id AND m.id = $1 AND l.owner_id = $2`,
      [input.mediaId, input.ownerId, input.blurhash ?? null,
       input.width ?? null, input.height ?? null],
    );
    if (res.rowCount === 0) throw notFound('Photo not found.');
  }

  /**
   * Deletes an object and its upload record. Used when a photo is removed.
   *
   * Storage first: a row without an object shows a broken image, while an
   * object without a row is invisible and swept later. Failing in the safer
   * order matters more than which call is cheaper.
   */
  async discard(storageKey: string, ownerId: string): Promise<void> {
    const { rows } = await this.#db.query<{ id: string }>(
      'SELECT id FROM uploads WHERE storage_key = $1 AND owner_id = $2',
      [storageKey, ownerId],
    );
    if (!rows[0]) throw notFound('Upload not found.');
    await this.#storage.delete(storageKey);
    await this.#db.query('DELETE FROM uploads WHERE id = $1', [rows[0].id]);
  }

  /**
   * Marks abandoned tickets expired and deletes anything they left behind.
   *
   * A ticket that is never completed is the normal outcome of a closed tab, so
   * this is routine rather than exceptional — but the object may exist, and
   * without this it is a byte nobody knows about and nobody pays attention to.
   */
  async sweepAbandoned(limit = 200): Promise<number> {
    const { rows } = await this.#db.query<{ id: string; storage_key: string }>(
      `UPDATE uploads SET status = 'expired'
        WHERE id IN (
          SELECT id FROM uploads
           WHERE status = 'pending' AND expires_at < now() - interval '1 hour'
           ORDER BY expires_at
           LIMIT $1
        )
        RETURNING id, storage_key`,
      [limit],
    );
    for (const r of rows) {
      // Best effort: an object that was never uploaded 404s, which delete()
      // treats as success. A real failure should not abort the whole sweep.
      try {
        await this.#storage.delete(r.storage_key);
      } catch {
        /* retried on the next sweep */
      }
    }
    return rows.length;
  }

  /**
   * Destroys the bytes behind documents whose retention has run out.
   *
   * `DocumentService.collectExpired()` has existed since the locker was built
   * and has never had a caller, which meant PIPEDA retention deletion was a
   * column and not a behaviour. This is the caller.
   */
  async purgeExpiredDocuments(keys: readonly string[]): Promise<number> {
    let destroyed = 0;
    for (const key of keys) {
      try {
        await this.#storage.delete(key);
        await this.#db.query(
          `UPDATE documents SET deleted_at = now(), status = 'rejected'
            WHERE storage_key = $1 AND deleted_at IS NULL`,
          [key],
        );
        destroyed += 1;
      } catch {
        /* retried on the next run; the row stays due for deletion */
      }
    }
    return destroyed;
  }

  async #reject(uploadId: string, reason: string): Promise<void> {
    await this.#db.query(
      `UPDATE uploads SET status = 'rejected', reject_reason = $2, completed_at = now()
        WHERE id = $1`,
      [uploadId, reason],
    );
  }

  async #alreadyStored(uploadId: string): Promise<CompletionOutcome> {
    const { rows } = await this.#db.query<{
      id: string; subject_type: UploadSubject; subject_id: string;
      verified_bytes: string | null; verified_mime: string | null;
      content_hash: Buffer | null; metadata_stripped: string[];
      had_gps: boolean; exif_orientation: number | null;
    }>(
      `SELECT id, subject_type, subject_id, verified_bytes, verified_mime,
              content_hash, metadata_stripped, had_gps, exif_orientation
         FROM uploads WHERE id = $1`,
      [uploadId],
    );
    const r = rows[0];
    if (!r) throw conflict('Upload is in an unexpected state.');
    return {
      ok: true,
      uploadId: r.id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      bytes: Number(r.verified_bytes ?? 0),
      mime: r.verified_mime ?? 'application/octet-stream',
      contentHash: r.content_hash ? r.content_hash.toString('hex') : '',
      metadataStripped: r.metadata_stripped,
      orientation: r.exif_orientation,
      hadGps: r.had_gps,
    };
  }
}

export { RENDERABLE };
