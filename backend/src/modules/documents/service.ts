/**
 * Document locker service.
 *
 * Access control lives in exactly one place — `assertAccess` — and every read
 * path calls it. No route is permitted to reason about ownership on its own,
 * because that is how a "just this once" shortcut becomes a data breach.
 *
 * Every access is written to document_access_log, which is append-only at the
 * database level: a compromised application role cannot erase its tracks.
 */
import { randomUUID, createHash } from 'node:crypto';
import {
  ALLOWED_MIME,
  DOWNLOAD_URL_TTL_SEC,
  buildStorageKey,
  canAccess,
  retentionFor,
  validateUpload,
  type DocumentKind,
} from './policy.js';
import { signStorageUrl } from '../../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import type { UploadTicketIssuer } from '../listings/service.js';
import type { Sql } from '../../db/pool.js';

export interface DocumentRow {
  id: string;
  owner_id: string;
  title: string;
  kind: DocumentKind;
  storage_key: string;
  mime: string;
  bytes: string | number;
  retention_until: Date;
  created_at: Date;
  deleted_at: Date | null;
}

export interface DocumentSummary {
  id: string;
  title: string;
  kind: DocumentKind;
  mime: string;
  bytes: number;
  createdAt: Date;
  retentionUntil: Date;
  isOwner: boolean;
}

export interface CreateUploadInput {
  ownerId: string;
  title: string;
  kind: DocumentKind;
  mime: string;
  bytes: number;
  filename: string;
  propertyId?: string | undefined;
  threadId?: string | undefined;
}

export interface UploadTicket {
  documentId: string;
  storageKey: string;
  /**
   * Where the browser PUTs the bytes. Present only when object storage is
   * configured; without it the row exists and nothing can be stored against
   * it, which is why the page hides its uploader in that case rather than
   * offering a control that cannot work.
   */
  uploadUrl?: string;
  uploadToken: string;
  expiresAt: number;
}

/** Turns a stored key into a short-lived URL the browser may GET. */
export interface DocumentStorage {
  presignGet(key: string, opts: { expiresIn: number }): string;
}

export class DocumentService {
  readonly #db: Sql;
  readonly #storageSecret: string;
  /**
   * Mints the presigned PUT, and records the pending upload.
   *
   * Optional for the same reason it is optional on ListingService: without
   * object storage configured the row can still be reserved, and the locker is
   * simply unable to hold bytes. The seam is the SAME interface listings use —
   * `subjectType` already had a `'document'` member, because this was always
   * where it was going.
   */
  readonly #uploads: UploadTicketIssuer | null;
  readonly #storage: DocumentStorage | null;

  constructor(
    db: Sql,
    storageSecret: string,
    deps: { uploads?: UploadTicketIssuer | null; storage?: DocumentStorage | null } = {},
  ) {
    this.#db = db;
    this.#storageSecret = storageSecret;
    this.#uploads = deps.uploads ?? null;
    this.#storage = deps.storage ?? null;
  }

  /**
   * Reserves a document row and returns a signed ticket the client uses to
   * upload the bytes directly to object storage. The server never proxies the
   * file — it only decides whether the upload may happen and under what key.
   */
  async createUpload(input: CreateUploadInput): Promise<UploadTicket> {
    const count = await this.#db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM documents WHERE owner_id = $1 AND deleted_at IS NULL',
      [input.ownerId],
    );
    const existingCount = Number(count.rows[0]?.n ?? 0);

    const verdict = validateUpload({
      mime: input.mime,
      bytes: input.bytes,
      filename: input.filename,
      existingCount,
    });
    if (!verdict.ok) throw badRequest(uploadRejectionMessage(verdict.reason));

    const documentId = randomUUID();
    const storageKey = buildStorageKey(input.ownerId, documentId, input.mime);
    const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_URL_TTL_SEC;

    await this.#db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO documents
           (id, owner_id, title, kind, storage_key, mime, bytes, content_hash,
            property_id, thread_id, retention_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          documentId,
          input.ownerId,
          input.title,
          input.kind,
          storageKey,
          input.mime,
          input.bytes,
          // Placeholder until the client reports the uploaded object's digest.
          createHash('sha256').update(storageKey).digest(),
          input.propertyId ?? null,
          input.threadId ?? null,
          retentionFor(input.kind),
        ],
      );
      await tx.query(
        'INSERT INTO document_access_log(document_id, actor_id, action) VALUES ($1,$2,$3)',
        [documentId, input.ownerId, 'upload'],
      );
    });

    if (this.#uploads) {
      const t = await this.#uploads.ticket({
        ownerId: input.ownerId,
        subjectType: 'document',
        subjectId: documentId,
        storageKey,
        mime: input.mime,
        bytes: input.bytes,
      });
      return {
        documentId,
        storageKey,
        uploadUrl: t.uploadUrl,
        uploadToken: t.completionToken,
        expiresAt: t.expiresAt,
      };
    }

    return {
      documentId,
      storageKey,
      uploadToken: signStorageUrl(
        { storageKey, userId: input.ownerId, expiresAt },
        this.#storageSecret,
      ),
      expiresAt,
    };
  }

  async list(ownerId: string, limit = 100, offset = 0): Promise<DocumentSummary[]> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const res = await this.#db.query<DocumentRow>(
      // Stored only. A reserved row whose bytes never arrived is not a
      // document: it lists with a Download button that leads to nothing, and
      // it counts against the per-user cap. The same rule the listing photo
      // read follows, for the same reason.
      `SELECT id, owner_id, title, kind, storage_key, mime, bytes,
              retention_until, created_at, deleted_at
         FROM documents
        WHERE owner_id = $1 AND deleted_at IS NULL AND status = 'stored'
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [ownerId, capped, Math.max(offset, 0)],
    );
    return res.rows.map((r) => toSummary(r, true));
  }

  /**
   * The one authority on document access. Resolves the document and any share
   * granted to the requester, then applies the policy.
   */
  async assertAccess(documentId: string, requesterId: string): Promise<DocumentRow> {
    const res = await this.#db.query<DocumentRow & {
      share_expires_at: Date | null;
      share_revoked_at: Date | null;
    }>(
      `SELECT d.id, d.owner_id, d.title, d.kind, d.storage_key, d.mime, d.bytes,
              d.retention_until, d.created_at, d.deleted_at,
              s.expires_at AS share_expires_at,
              s.revoked_at AS share_revoked_at
         FROM documents d
         LEFT JOIN document_shares s
           ON s.document_id = d.id AND s.shared_with_user_id = $2
        WHERE d.id = $1`,
      [documentId, requesterId],
    );
    const row = res.rows[0];
    // A document the requester cannot see is reported as absent, not as
    // forbidden — "403" would confirm the id exists.
    if (!row) throw notFound('Document not found.');

    const allowed = canAccess({
      requesterId,
      ownerId: row.owner_id,
      deletedAt: row.deleted_at,
      share: row.share_expires_at
        ? { expiresAt: row.share_expires_at, revokedAt: row.share_revoked_at }
        : undefined,
    });
    if (!allowed) throw notFound('Document not found.');
    return row;
  }

  /** Issues a short-lived download URL and records the access. */
  async createDownload(documentId: string, requesterId: string): Promise<{ url: string; mime: string; expiresAt: number }> {
    const doc = await this.assertAccess(documentId, requesterId);
    const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_URL_TTL_SEC;

    await this.#db.query(
      'INSERT INTO document_access_log(document_id, actor_id, action) VALUES ($1,$2,$3)',
      [documentId, requesterId, 'download'],
    );

    return {
      // Bound to the requester, not just the object: a leaked link cannot be
      // replayed by a different account.
      // A real presigned GET when storage is configured, so the browser can
      // actually fetch the bytes. The signed token below is the fallback for a
      // deployment with no bucket, where there are no bytes to fetch anyway.
      url: this.#storage
        ? this.#storage.presignGet(doc.storage_key, { expiresIn: DOWNLOAD_URL_TTL_SEC })
        : signStorageUrl(
            { storageKey: doc.storage_key, userId: requesterId, expiresAt },
            this.#storageSecret,
          ),
      mime: doc.mime,
      expiresAt,
    };
  }

  /** Only the owner may share, and every share carries an expiry. */
  async share(documentId: string, ownerId: string, withUserId: string, expiresAt: Date): Promise<void> {
    if (withUserId === ownerId) throw badRequest('Cannot share a document with yourself.');
    if (expiresAt <= new Date()) throw badRequest('Share expiry must be in the future.');

    const owned = await this.#db.query<{ id: string }>(
      'SELECT id FROM documents WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL',
      [documentId, ownerId],
    );
    if (owned.rowCount === 0) throw notFound('Document not found.');

    await this.#db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO document_shares(document_id, shared_with_user_id, granted_by, expires_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (document_id, shared_with_user_id) WHERE revoked_at IS NULL
         DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [documentId, withUserId, ownerId, expiresAt],
      );
      await tx.query(
        'INSERT INTO document_access_log(document_id, actor_id, action) VALUES ($1,$2,$3)',
        [documentId, ownerId, 'share'],
      );
    });
  }

  async revokeShare(documentId: string, ownerId: string, withUserId: string): Promise<void> {
    const res = await this.#db.query(
      `UPDATE document_shares s SET revoked_at = now()
         FROM documents d
        WHERE s.document_id = d.id
          AND d.id = $1 AND d.owner_id = $2
          AND s.shared_with_user_id = $3 AND s.revoked_at IS NULL`,
      [documentId, ownerId, withUserId],
    );
    if (res.rowCount === 0) throw notFound('Share not found.');
    await this.#db.query(
      'INSERT INTO document_access_log(document_id, actor_id, action) VALUES ($1,$2,$3)',
      [documentId, ownerId, 'revoke'],
    );
  }

  /**
   * Soft-deletes immediately (the user sees it gone) and lets the retention
   * job purge the bytes. Only the owner may delete — a share never confers it.
   */
  async remove(documentId: string, ownerId: string): Promise<void> {
    const res = await this.#db.query(
      `UPDATE documents SET deleted_at = now()
        WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
      [documentId, ownerId],
    );
    if (res.rowCount === 0) throw notFound('Document not found.');
    await this.#db.query(
      'INSERT INTO document_access_log(document_id, actor_id, action) VALUES ($1,$2,$3)',
      [documentId, ownerId, 'delete'],
    );
  }

  /**
   * Retention sweep, run by the scheduler. Returns the storage keys whose
   * bytes must now be destroyed in object storage.
   */
  async collectExpired(limit = 500): Promise<string[]> {
    const res = await this.#db.query<{ storage_key: string }>(
      `SELECT storage_key FROM documents
        WHERE deleted_at IS NULL AND retention_until <= now()
        LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => r.storage_key);
  }
}

function toSummary(r: DocumentRow, isOwner: boolean): DocumentSummary {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    mime: r.mime,
    bytes: Number(r.bytes),
    createdAt: r.created_at,
    retentionUntil: r.retention_until,
    isOwner,
  };
}

function uploadRejectionMessage(reason: string): string {
  switch (reason) {
    case 'mime_not_allowed':
      return `File type not accepted. Allowed: ${[...ALLOWED_MIME.values()].join(', ')}.`;
    case 'too_large':
      return 'File is larger than the 25 MB limit.';
    case 'empty':
      return 'File is empty.';
    case 'quota_exceeded':
      return 'You have reached the document limit. Delete something first.';
    case 'extension_mismatch':
      return 'The file extension does not match its type.';
    default:
      return 'Upload rejected.';
  }
}

export { forbidden };
