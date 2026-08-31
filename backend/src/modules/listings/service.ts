/**
 * Listing service.
 *
 * Three rules hold everywhere in this file, and every method is written to
 * make breaking them awkward:
 *
 *  1. `owner_id` comes from the session. It is never read from a payload, so
 *     there is no request shape that creates a listing under someone else's
 *     name.
 *
 *  2. `status` is never assigned from input. It moves only through
 *     `transition()`, which asks state.ts first. An "update the listing"
 *     endpoint that accepts a status field is a self-approval endpoint.
 *
 *  3. A listing that the caller may not see is reported as absent, not as
 *     forbidden. 403 on a draft would confirm the id exists and who owns it.
 */
import { randomUUID } from 'node:crypto';
import {
  buildSearchText,
  checkPrice,
  normalizeAmenities,
  normalizePostalCode,
  priceRejectionMessage,
  propertyKey,
  publishBlockers,
  rescanRequired,
  riskScore,
  roomTypeAllowed,
  scanContent,
  scanPrice,
  ALLOWED_PHOTO_MIME,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  type DescriptionSource,
  type PropertyType,
  type RiskSignal,
  type RoomType,
} from './policy.js';
import {
  availableActions,
  canTransition,
  resolveAction,
  isPublic,
  type Actor,
  type ListingAction,
  type ListingMode,
  type ListingStatus,
} from './state.js';
import { signStorageUrl } from '../../lib/crypto.js';
import type { AuditRecorder } from '../audit/service.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import type { Sql } from '../../db/pool.js';

/** Days a listing stays live before the sweeper expires it. */
export const LISTING_TTL_DAYS = 90;
const PHOTO_UPLOAD_TTL_SEC = 900;

export interface CreateListingInput {
  ownerId: string;
  mode: ListingMode;
  propertyType: PropertyType;
  priceCents: number;
  title: string;
  description?: string | null;
  descriptionSource?: DescriptionSource;
  roomType?: RoomType | null;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  amenities?: readonly string[];
  address: {
    addressLine: string;
    unit?: string | null;
    city: string;
    province: string;
    postalCode?: string | null;
  };
}

export type UpdateListingInput = Partial<
  Pick<
    CreateListingInput,
    'priceCents' | 'title' | 'description' | 'descriptionSource' | 'roomType' | 'beds' | 'baths' | 'sqft' | 'amenities'
  >
>;

export interface ListingRow {
  id: string;
  property_id: string;
  owner_id: string;
  mode: ListingMode;
  status: ListingStatus;
  price_cents: string | number;
  room_type: RoomType | null;
  property_type: PropertyType;
  beds: number | null;
  baths: string | null;
  sqft: number | null;
  amenities: string[];
  title: string;
  description: string | null;
  description_source: DescriptionSource;
  description_attested_at: Date | null;
  published_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListingView {
  id: string;
  mode: ListingMode;
  status: ListingStatus;
  priceCents: number;
  propertyType: PropertyType;
  roomType: RoomType | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  amenities: string[];
  title: string;
  description: string | null;
  descriptionSource: DescriptionSource;
  descriptionAttested: boolean;
  publishedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  address: {
    addressLine: string;
    unit: string | null;
    city: string;
    province: string;
    postalCode: string | null;
    lat: number | null;
    lng: number | null;
  };
  photos: PhotoView[];
  /** Present only for the owner and staff. */
  actions?: ListingAction[];
  isOwner: boolean;
}

export interface PhotoView {
  id: string;
  storageKey: string;
  kind: string;
  mime: string;
  bytes: number;
  position: number;
}

export interface PhotoTicket {
  photoId: string;
  storageKey: string;
  /**
   * Where the browser PUTs the bytes. Present only when object storage is
   * configured; otherwise the row is reserved but nothing can be stored.
   */
  uploadUrl?: string;
  /** Presented to /api/uploads/complete once the PUT succeeds. */
  uploadToken: string;
  expiresAt: number;
}

/** Issues the presigned PUT and records the pending upload. */
export interface UploadTicketIssuer {
  ticket(input: {
    ownerId: string;
    subjectType: 'listing_media' | 'document';
    subjectId: string;
    storageKey: string;
    mime: string;
    bytes: number;
  }): Promise<{ uploadUrl: string; completionToken: string; expiresAt: number }>;
}

export interface Viewer {
  userId: string | null;
  role: 'user' | 'staff' | 'admin';
}

export const ANONYMOUS: Viewer = { userId: null, role: 'user' };

/**
 * Resolves a typed address to an authoritative coordinate. Supplied by the
 * gazetteer; optional so the service still works before it is loaded.
 */
export interface AddressResolver {
  resolve(input: { addressLine: string; unit?: string | null; city: string; province: string }):
    Promise<{ lat: number; lng: number; neighbourhoodId: string | null; postalCode: string | null } | null>;
}

export class ListingService {
  readonly #db: Sql;
  readonly #storageSecret: string;
  readonly #now: () => Date;
  readonly #geocoder: AddressResolver | null;
  readonly #uploads: UploadTicketIssuer | null;
  /** Records staff decisions inside the same transaction that makes them. */
  readonly #audit: AuditRecorder | null;

  constructor(
    db: Sql,
    storageSecret: string,
    opts: {
      now?: () => Date;
      geocoder?: AddressResolver | null;
      uploads?: UploadTicketIssuer | null;
      audit?: AuditRecorder | null;
    } = {},
  ) {
    this.#db = db;
    this.#storageSecret = storageSecret;
    this.#now = opts.now ?? (() => new Date());
    this.#geocoder = opts.geocoder ?? null;
    this.#uploads = opts.uploads ?? null;
    this.#audit = opts.audit ?? null;
  }

  // ── create ────────────────────────────────────────────────────────────────

  /**
   * Creates a draft. Always a draft — there is no argument that starts a
   * listing anywhere else, so nothing reaches the public without passing
   * through submit and review.
   */
  async create(input: CreateListingInput): Promise<{ id: string; propertyId: string }> {
    const amenities = this.#amenitiesOrThrow(input.amenities ?? []);
    this.#assertPriceInBand(input.priceCents, input.mode);
    this.#assertRoomType(input.mode, input.roomType);

    const province = input.address.province.toUpperCase();
    if (!/^[A-Z]{2}$/.test(province)) throw badRequest('Province must be a two-letter code.');

    const norm = propertyKey(input.address.addressLine, input.address.unit);
    if (!norm) throw badRequest('Enter a street address.');

    const city = input.address.city.trim();
    const postal = normalizePostalCode(input.address.postalCode);
    if (input.address.postalCode && !postal) {
      throw badRequest('Postal code is not in a recognized format.');
    }

    const listingId = randomUUID();
    const description = input.description?.trim() || null;
    const source = input.descriptionSource ?? 'human';

    // Coordinates come from the City of Regina gazetteer, never from Apple.
    // Apple's licence defines latitude and longitude as Map Data and forbids
    // retaining it, and a property row keeps its coordinate permanently — so
    // the pin has to be geocoded from data we are allowed to store, and only
    // RENDERED on an Apple map. Resolution failing is not an error: the
    // listing is created without a coordinate and simply does not appear on
    // the map until an address point matches.
    const located = this.#geocoder
      ? await this.#geocoder.resolve({
          addressLine: input.address.addressLine,
          unit: input.address.unit ?? null,
          city,
          province,
        }).catch(() => null)
      : null;

    return this.#db.transaction(async (tx) => {
      // Fill gaps on an existing property, never overwrite. Two owners can
      // legitimately reach the same row (a landlord and a previous seller),
      // and the second must not be able to rewrite the first's data.
      const prop = await tx.query<{ id: string }>(
        `INSERT INTO properties
           (address_line, unit, address_norm, city, province, postal_code,
            lat, lng, neighbourhood_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (address_norm, city, province) DO UPDATE
           SET postal_code      = COALESCE(properties.postal_code, EXCLUDED.postal_code),
               lat              = COALESCE(properties.lat, EXCLUDED.lat),
               lng              = COALESCE(properties.lng, EXCLUDED.lng),
               neighbourhood_id = COALESCE(properties.neighbourhood_id, EXCLUDED.neighbourhood_id),
               updated_at       = now()
         RETURNING id`,
        [
          input.address.addressLine.trim(),
          input.address.unit?.trim() || null,
          norm,
          city,
          province,
          postal ?? located?.postalCode ?? null,
          located?.lat ?? null,
          located?.lng ?? null,
          located?.neighbourhoodId ?? null,
        ],
      );
      const propertyId = prop.rows[0]!.id;

      const searchText = buildSearchText({
        title: input.title,
        description,
        addressLine: input.address.addressLine,
        city,
        propertyType: input.propertyType,
        amenities,
      });

      await tx.query(
        `INSERT INTO listings
           (id, property_id, owner_id, mode, status, price_cents, room_type,
            property_type, beds, baths, sqft, amenities, title, description,
            description_source, search_text)
         VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          listingId, propertyId, input.ownerId, input.mode, input.priceCents,
          input.roomType ?? null, input.propertyType, input.beds ?? null,
          input.baths ?? null, input.sqft ?? null, amenities, input.title.trim(),
          description, source, searchText,
        ],
      );

      await this.#writeSignals(tx, listingId, [
        ...scanContent({ title: input.title, description }),
        ...scanPrice(input.priceCents, input.mode),
      ]);

      return { id: listingId, propertyId };
    });
  }

  // ── read ──────────────────────────────────────────────────────────────────

  /**
   * The one authority on listing visibility. Every read path goes through it.
   *
   * A live listing is public. Anything else belongs to its owner and to
   * staff, and to everyone else it does not exist.
   */
  async get(listingId: string, viewer: Viewer): Promise<ListingView> {
    const res = await this.#db.query<ListingRow & PropertyCols>(
      `SELECT l.*, p.address_line, p.unit, p.city, p.province, p.postal_code, p.lat, p.lng
         FROM listings l
         JOIN properties p ON p.id = l.property_id
        WHERE l.id = $1`,
      [listingId],
    );
    const row = res.rows[0];
    if (!row) throw notFound('Listing not found.');

    const isOwner = viewer.userId !== null && viewer.userId === row.owner_id;
    const isStaff = viewer.role === 'staff' || viewer.role === 'admin';
    if (!isPublic(row.status) && !isOwner && !isStaff) throw notFound('Listing not found.');

    const photos = await this.#photosFor([listingId]);
    const view = toView(row, photos.get(listingId) ?? [], isOwner);

    if (isOwner) view.actions = availableActions(row.status, 'owner', row.mode);
    else if (isStaff) view.actions = availableActions(row.status, 'staff', row.mode);
    return view;
  }

  /**
   * An owner's own listings, drafts included.
   *
   * Photos are fetched for the whole page in one query rather than per row.
   * The N+1 version of this is the first thing that shows up in
   * pg_stat_statements once a handful of owners have ten listings each.
   */
  async listForOwner(ownerId: string, opts: { limit?: number; offset?: number; status?: ListingStatus } = {}): Promise<ListingView[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);

    const res = await this.#db.query<ListingRow & PropertyCols>(
      `SELECT l.*, p.address_line, p.unit, p.city, p.province, p.postal_code, p.lat, p.lng
         FROM listings l
         JOIN properties p ON p.id = l.property_id
        WHERE l.owner_id = $1
          AND ($4::text IS NULL OR l.status = $4)
        ORDER BY l.updated_at DESC
        LIMIT $2 OFFSET $3`,
      [ownerId, limit, offset, opts.status ?? null],
    );
    if (res.rows.length === 0) return [];

    const photos = await this.#photosFor(res.rows.map((r) => r.id));
    return res.rows.map((r) => {
      const view = toView(r, photos.get(r.id) ?? [], true);
      view.actions = availableActions(r.status, 'owner', r.mode);
      return view;
    });
  }

  // ── update ────────────────────────────────────────────────────────────────

  /**
   * Edits a listing the caller owns.
   *
   * The address is deliberately absent from the patch type. An address change
   * is not an edit — it is a different property, and allowing it would let an
   * approved listing be relocated after review, which is the same bypass the
   * copy rescan exists to close.
   */
  async update(listingId: string, ownerId: string, patch: UpdateListingInput): Promise<{ rescanned: boolean }> {
    if (Object.keys(patch).length === 0) throw badRequest('Nothing to update.');

    return this.#db.transaction(async (tx) => {
      const res = await tx.query<ListingRow & PropertyCols>(
        `SELECT l.*, p.address_line, p.unit, p.city, p.province, p.postal_code, p.lat, p.lng
           FROM listings l
           JOIN properties p ON p.id = l.property_id
          WHERE l.id = $1
          FOR UPDATE OF l`,
        [listingId],
      );
      const row = res.rows[0];
      if (!row || row.owner_id !== ownerId) throw notFound('Listing not found.');
      if (row.status === 'rented' || row.status === 'sold') {
        throw conflict('This listing is closed. Create a new one to list the property again.');
      }

      const next = {
        priceCents: patch.priceCents ?? Number(row.price_cents),
        title: (patch.title ?? row.title).trim(),
        description:
          patch.description === undefined ? row.description : (patch.description?.trim() || null),
        descriptionSource: patch.descriptionSource ?? row.description_source,
        roomType: patch.roomType === undefined ? row.room_type : patch.roomType,
        beds: patch.beds === undefined ? row.beds : patch.beds,
        baths: patch.baths === undefined ? (row.baths === null ? null : Number(row.baths)) : patch.baths,
        sqft: patch.sqft === undefined ? row.sqft : patch.sqft,
        amenities: patch.amenities ? this.#amenitiesOrThrow(patch.amenities) : row.amenities,
      };

      this.#assertPriceInBand(next.priceCents, row.mode);
      this.#assertRoomType(row.mode, next.roomType);

      // Rewriting the copy re-arms attestation. Otherwise an owner attests to
      // a clean AI description, then edits it into something else while the
      // attestation timestamp still stands.
      const copyChanged = next.title !== row.title || next.description !== row.description;
      const sourceChanged = next.descriptionSource !== row.description_source;
      const attestedAt =
        copyChanged || sourceChanged ? null : row.description_attested_at;

      const searchText = buildSearchText({
        title: next.title,
        description: next.description,
        addressLine: row.address_line,
        city: row.city,
        propertyType: row.property_type,
        amenities: next.amenities,
      });

      // A live listing whose new copy trips a signal goes back to the queue.
      const rescan =
        row.status === 'live' &&
        rescanRequired(
          { title: row.title, description: row.description },
          { title: next.title, description: next.description },
        );

      // An AI description that has lost its attestation cannot stay live —
      // the database trigger would refuse the write anyway, so send it back
      // to draft with an explanation rather than hitting a constraint.
      const losesAttestation =
        row.status === 'live' && next.descriptionSource !== 'human' && attestedAt === null;

      const nextStatus: ListingStatus = losesAttestation
        ? 'draft'
        : rescan
          ? 'pending_review'
          : row.status;

      await tx.query(
        `UPDATE listings
            SET price_cents = $2, title = $3, description = $4,
                description_source = $5, description_attested_at = $6,
                room_type = $7, beds = $8, baths = $9, sqft = $10,
                amenities = $11, search_text = $12, status = $13
          WHERE id = $1`,
        [
          listingId, next.priceCents, next.title, next.description,
          next.descriptionSource, attestedAt, next.roomType, next.beds,
          next.baths, next.sqft, next.amenities, searchText, nextStatus,
        ],
      );

      if (copyChanged || patch.priceCents !== undefined) {
        await this.#writeSignals(tx, listingId, [
          ...scanContent({ title: next.title, description: next.description }),
          ...scanPrice(next.priceCents, row.mode),
        ]);
      }
      if (nextStatus === 'pending_review' && row.status !== 'pending_review') {
        await this.#enqueueModeration(tx, listingId, 'edited_after_approval');
      }

      return { rescanned: rescan };
    });
  }

  /**
   * Records that the owner has read and stands behind an AI-written
   * description. Required by `listings_publish_guard` before publish.
   *
   * Competition Act s.74.01 makes the person who publishes a representation
   * responsible for it. Attestation is where that responsibility is recorded
   * as having been accepted, so it is an explicit action and never a field
   * the create or update payload can set.
   */
  async attestDescription(listingId: string, ownerId: string): Promise<void> {
    const res = await this.#db.query(
      `UPDATE listings SET description_attested_at = now()
        WHERE id = $1 AND owner_id = $2
          AND description IS NOT NULL
          AND description_source <> 'human'`,
      [listingId, ownerId],
    );
    if (res.rowCount === 0) {
      throw notFound('No AI-written description on this listing to confirm.');
    }
  }

  // ── transitions ───────────────────────────────────────────────────────────

  /**
   * Moves a listing through the publish state machine.
   *
   * `actor` is derived from the session and the listing's owner, never sent
   * by the client, and the client names an action rather than a target
   * status — so there is no request that says "set this to live".
   */
  async transition(
    listingId: string,
    viewer: Viewer,
    action: ListingAction,
    opts: { reason?: string; ip?: string } = {},
  ): Promise<{ status: ListingStatus }> {
    return this.#db.transaction(async (tx) => {
      const res = await tx.query<ListingRow & { email_verified_at: Date | null }>(
        `SELECT l.*, u.email_verified_at
           FROM listings l
           JOIN users u ON u.id = l.owner_id
          WHERE l.id = $1
          FOR UPDATE OF l`,
        [listingId],
      );
      const row = res.rows[0];
      if (!row) throw notFound('Listing not found.');

      const isOwner = viewer.userId !== null && viewer.userId === row.owner_id;
      const isStaff = viewer.role === 'staff' || viewer.role === 'admin';
      if (!isOwner && !isStaff) throw notFound('Listing not found.');

      // Staff acting on their own listing act as the owner: a moderator must
      // not be able to approve their own posting.
      const actor: Actor = isOwner ? 'owner' : 'staff';

      const verdict = resolveAction(action, row.status, actor, row.mode);
      if (!verdict.ok) throw transitionError(verdict.reason, row.status, action);

      if (verdict.to === 'pending_review') {
        await this.#assertReadyToPublish(tx, row);
        await this.#enqueueModeration(tx, listingId, opts.reason ?? 'owner_submitted');
      }

      const goingLive = verdict.to === 'live';
      const now = this.#now();
      const expiresAt = goingLive
        ? new Date(now.getTime() + LISTING_TTL_DAYS * 24 * 60 * 60 * 1000)
        : null;

      try {
        await tx.query(
          `UPDATE listings
              SET status = $2,
                  published_at = CASE WHEN $3 THEN COALESCE(published_at, now()) ELSE published_at END,
                  expires_at   = CASE WHEN $3 THEN $4 ELSE expires_at END
            WHERE id = $1`,
          [listingId, verdict.to, goingLive, expiresAt],
        );
      } catch (err) {
        // listings_one_live_per_property: another listing for the same
        // property is already public. Two owners can reach the same property
        // row legitimately, so this is a real state, not a bug.
        if (isUniqueViolation(err, 'listings_one_live_per_property')) {
          throw conflict(
            'Another listing for this address is already published. ' +
            'If it is not yours, report it and we will look into it.',
          );
        }
        throw err;
      }

      // A staff decision closes the queue entry it was made from, and is
      // recorded. Both happen inside THIS transaction, so a decision cannot
      // exist without its audit entry or the other way round.
      if (isStaff && (verdict.to === 'live' || verdict.to === 'rejected')) {
        await tx.query(
          `UPDATE moderation_queue
              SET state = $3, decided_by = $2, decided_at = now()
            WHERE subject_type = 'listing' AND subject_id = $1 AND state = 'open'`,
          [listingId, viewer.userId, verdict.to === 'live' ? 'approved' : 'rejected'],
        );

        await this.#audit?.record(tx, {
          actorId: viewer.userId!,
          actorRole: viewer.role,
          action: verdict.to === 'live' ? 'listing.approve' : 'listing.reject',
          subject: 'listing',
          subjectId: listingId,
          before: { status: row.status },
          after: {
            status: verdict.to,
            ...(opts.reason ? { reason: opts.reason } : {}),
          },
          ip: opts.ip,
        });
      }

      return { status: verdict.to };
    });
  }

  /**
   * Expires listings past their TTL. Run by the scheduled job runner.
   *
   * A stale listing is worse than no listing: the single loudest complaint
   * about every classifieds marketplace is that half of what is shown is
   * already gone.
   */
  async expireStale(limit = 500): Promise<number> {
    const res = await this.#db.query(
      `UPDATE listings SET status = 'expired'
        WHERE id IN (
          SELECT id FROM listings
           WHERE status IN ('live','paused')
             AND expires_at IS NOT NULL
             AND expires_at <= now()
           ORDER BY expires_at
           LIMIT $1
        )`,
      [limit],
    );
    return res.rowCount;
  }

  // ── photos ────────────────────────────────────────────────────────────────

  /**
   * Reserves a photo slot and returns a ticket for a direct-to-storage
   * upload. The bytes never pass through the server; it only decides whether
   * the upload may happen and under what key.
   */
  async addPhoto(
    listingId: string,
    ownerId: string,
    input: { mime: string; bytes: number; kind?: 'photo' | 'tour_3d' | 'floorplan' },
  ): Promise<PhotoTicket> {
    if (!ALLOWED_PHOTO_MIME.has(input.mime)) {
      throw badRequest(`Photo type not accepted. Allowed: ${[...ALLOWED_PHOTO_MIME].join(', ')}.`);
    }
    if (input.bytes <= 0) throw badRequest('Photo is empty.');
    if (input.bytes > MAX_PHOTO_BYTES) {
      throw badRequest(`Photo is larger than the ${MAX_PHOTO_BYTES / (1024 * 1024)} MB limit.`);
    }

    const photoId = randomUUID();
    const storageKey = `listings/${listingId}/${photoId}`;

    await this.#db.transaction(async (tx) => {
      const owned = await tx.query<{ id: string }>(
        // Locking the listing row serializes concurrent uploads, so the count
        // check below cannot be raced past the cap by parallel requests.
        'SELECT id FROM listings WHERE id = $1 AND owner_id = $2 FOR UPDATE',
        [listingId, ownerId],
      );
      if (owned.rowCount === 0) throw notFound('Listing not found.');

      const count = await tx.query<{ n: string; next: string }>(
        `SELECT count(*)::text AS n, COALESCE(max(position) + 1, 0)::text AS next
           FROM listing_media WHERE listing_id = $1`,
        [listingId],
      );
      if (Number(count.rows[0]!.n) >= MAX_PHOTOS) {
        throw conflict(`This listing already has the maximum of ${MAX_PHOTOS} photos.`);
      }

      await tx.query(
        `INSERT INTO listing_media (id, listing_id, storage_key, kind, mime, bytes, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [photoId, listingId, storageKey, input.kind ?? 'photo', input.mime, input.bytes,
         Number(count.rows[0]!.next)],
      );
    });

    // The upload service mints the presigned PUT and records the pending
    // upload, so the row and the object are created by the same step. Without
    // it configured the row still exists — the listing is simply not
    // publishable until a photo can actually be stored.
    if (this.#uploads) {
      const t = await this.#uploads.ticket({
        ownerId,
        subjectType: 'listing_media',
        subjectId: photoId,
        storageKey,
        mime: input.mime,
        bytes: input.bytes,
      });
      return {
        photoId,
        storageKey,
        uploadUrl: t.uploadUrl,
        uploadToken: t.completionToken,
        expiresAt: t.expiresAt,
      };
    }

    const expiresAt = Math.floor(this.#now().getTime() / 1000) + PHOTO_UPLOAD_TTL_SEC;
    return {
      photoId,
      storageKey,
      // Bound to the uploader, so a leaked ticket cannot be replayed by
      // another account.
      uploadToken: signStorageUrl({ storageKey, userId: ownerId, expiresAt }, this.#storageSecret),
      expiresAt,
    };
  }

  async removePhoto(listingId: string, ownerId: string, photoId: string): Promise<void> {
    const res = await this.#db.query(
      `DELETE FROM listing_media m
        USING listings l
        WHERE m.listing_id = l.id
          AND m.id = $3 AND l.id = $1 AND l.owner_id = $2`,
      [listingId, ownerId, photoId],
    );
    if (res.rowCount === 0) throw notFound('Photo not found.');
  }

  /**
   * Reorders photos. The first is the one that carries the listing in search
   * results, which is the only ordering decision most owners care about.
   */
  async reorderPhotos(listingId: string, ownerId: string, photoIds: readonly string[]): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const owned = await tx.query<{ id: string }>(
        'SELECT id FROM listings WHERE id = $1 AND owner_id = $2 FOR UPDATE',
        [listingId, ownerId],
      );
      if (owned.rowCount === 0) throw notFound('Listing not found.');

      const existing = await tx.query<{ id: string }>(
        'SELECT id FROM listing_media WHERE listing_id = $1',
        [listingId],
      );
      const have = new Set(existing.rows.map((r) => r.id));
      // Require the complete set: a partial reorder leaves the rest at
      // positions that may now collide, and "sort of ordered" is worse than
      // an error the client can fix.
      if (photoIds.length !== have.size || photoIds.some((id) => !have.has(id))) {
        throw badRequest('Send every photo id for this listing, exactly once.');
      }
      if (new Set(photoIds).size !== photoIds.length) {
        throw badRequest('Photo ids must not repeat.');
      }

      for (const [i, id] of photoIds.entries()) {
        await tx.query('UPDATE listing_media SET position = $2 WHERE id = $1', [id, i]);
      }
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #amenitiesOrThrow(input: readonly string[]): string[] {
    const verdict = normalizeAmenities(input);
    if (!verdict.ok) {
      throw badRequest('Unrecognized amenities.', verdict.unknown.map((a) => `amenities: unknown value "${a}"`));
    }
    return verdict.value;
  }

  #assertPriceInBand(priceCents: number, mode: ListingMode): void {
    const verdict = checkPrice(priceCents, mode);
    if (!verdict.ok) throw badRequest(priceRejectionMessage(verdict.reason, mode));
  }

  #assertRoomType(mode: ListingMode, roomType: RoomType | null | undefined): void {
    if (roomType && !roomTypeAllowed(mode)) {
      throw badRequest('Room type applies to rentals only.');
    }
  }

  /** Gathers every reason a listing is not ready, and reports them together. */
  async #assertReadyToPublish(
    tx: Sql,
    row: ListingRow & { email_verified_at: Date | null },
  ): Promise<void> {
    const photos = await tx.query<{ n: string }>(
      // Only stored photos count. A reserved row whose bytes never arrived
      // must not make a listing look ready to publish.
      `SELECT count(*)::text AS n FROM listing_media
        WHERE listing_id = $1 AND kind = 'photo' AND status = 'stored'`,
      [row.id],
    );
    const blockers = publishBlockers({
      title: row.title,
      description: row.description,
      priceCents: Number(row.price_cents),
      mode: row.mode,
      propertyType: row.property_type,
      photoCount: Number(photos.rows[0]?.n ?? 0),
      descriptionSource: row.description_source,
      descriptionAttestedAt: row.description_attested_at,
      ownerEmailVerified: row.email_verified_at !== null,
    });
    if (blockers.length > 0) {
      throw badRequest('This listing is not ready to publish.', blockers);
    }
  }

  async #writeSignals(tx: Sql, listingId: string, signals: readonly RiskSignal[]): Promise<void> {
    for (const s of signals) {
      await tx.query(
        `INSERT INTO risk_signals (subject_type, subject_id, signal, weight, detail)
         VALUES ('listing', $1, $2, $3, $4)`,
        [listingId, s.signal, s.weight, JSON.stringify(s.detail)],
      );
    }
  }

  /**
   * Puts a listing in front of a moderator, scored by the signals recorded
   * for it. The queue is ordered by score, so the score is what decides
   * whether a human sees this today or next week.
   */
  async #enqueueModeration(tx: Sql, listingId: string, reason: string): Promise<void> {
    const signals = await tx.query<{ signal: string; weight: string }>(
      `SELECT signal, weight FROM risk_signals
        WHERE subject_type = 'listing' AND subject_id = $1
          AND at > now() - interval '30 days'`,
      [listingId],
    );
    const score = riskScore(
      signals.rows.map((r) => ({ signal: r.signal, weight: Number(r.weight), detail: {} })),
    );

    await tx.query(
      `INSERT INTO moderation_queue (subject_type, subject_id, reason, risk_score)
       VALUES ('listing', $1, $2, $3)
       ON CONFLICT (subject_type, subject_id) WHERE state = 'open'
       DO UPDATE SET risk_score = EXCLUDED.risk_score, reason = EXCLUDED.reason`,
      [listingId, reason, score],
    );
  }

  /** One query for a page of listings, rather than one per listing. */
  async #photosFor(listingIds: readonly string[]): Promise<Map<string, PhotoView[]>> {
    const out = new Map<string, PhotoView[]>();
    if (listingIds.length === 0) return out;

    const res = await this.#db.query<{
      id: string; listing_id: string; storage_key: string; kind: string;
      mime: string; bytes: string; position: number;
    }>(
      // Stored only, the same rule #assertReadyToPublish applies. A reserved
      // row whose bytes never arrived is not a photo: rendering it gives every
      // visitor a broken image, and counting it tells an owner their listing
      // has a photo right up until submitting refuses because it has none.
      `SELECT id, listing_id, storage_key, kind, mime, bytes, position
         FROM listing_media
        WHERE listing_id = ANY($1::uuid[]) AND status = 'stored'
        ORDER BY listing_id, position`,
      [listingIds as string[]],
    );
    for (const r of res.rows) {
      const list = out.get(r.listing_id) ?? [];
      list.push({
        id: r.id,
        storageKey: r.storage_key,
        kind: r.kind,
        mime: r.mime,
        bytes: Number(r.bytes),
        position: r.position,
      });
      out.set(r.listing_id, list);
    }
    return out;
  }
}

interface PropertyCols {
  address_line: string;
  unit: string | null;
  city: string;
  province: string;
  postal_code: string | null;
  lat: number | null;
  lng: number | null;
}

function toView(row: ListingRow & PropertyCols, photos: PhotoView[], isOwner: boolean): ListingView {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    priceCents: Number(row.price_cents),
    propertyType: row.property_type,
    roomType: row.room_type,
    beds: row.beds,
    baths: row.baths === null ? null : Number(row.baths),
    sqft: row.sqft,
    amenities: row.amenities,
    title: row.title,
    description: row.description,
    descriptionSource: row.description_source,
    descriptionAttested: row.description_attested_at !== null,
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    address: {
      addressLine: row.address_line,
      unit: row.unit,
      city: row.city,
      province: row.province,
      postalCode: row.postal_code,
      lat: row.lat,
      lng: row.lng,
    },
    photos,
    isOwner,
  };
}

/**
 * All four refusal reasons collapse to one client message except `wrong_mode`,
 * which names a genuine mistake the caller can fix. Telling a stranger
 * "you are not staff" tells them the listing exists and who can act on it.
 */
function transitionError(
  reason: 'terminal' | 'no_such_transition' | 'wrong_actor' | 'wrong_mode',
  from: ListingStatus,
  action: ListingAction,
) {
  if (reason === 'wrong_mode') {
    return badRequest('That action does not apply to this kind of listing.');
  }
  if (reason === 'terminal') {
    return conflict('This listing is closed. Create a new one to list the property again.');
  }
  return conflict(`Cannot ${action} a listing that is ${from.replace(/_/g, ' ')}.`);
}

/** Narrow check against a named constraint, so unrelated 23505s still throw. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  if (e.code !== '23505') return false;
  return constraint === undefined || e.constraint === constraint;
}

export { forbidden };
