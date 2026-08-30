/**
 * Listing routes.
 *
 * Two absences are the design:
 *
 *  - No route accepts `ownerId`. The owner is the session, always.
 *  - No route accepts `status`. Clients name an ACTION and the state machine
 *    decides the status, so there is no request body that says "make this
 *    listing live".
 */
import * as v from '../../lib/validate.js';
import { guard, type GuardConfig } from '../guard.js';
import { json, noContent, errorResponse, type ResponseContext } from '../respond.js';
import { badRequest } from '../../lib/errors.js';
import {
  AMENITIES,
  DESCRIPTION_SOURCES,
  PROPERTY_TYPES,
  ROOM_TYPES,
  MAX_PHOTOS,
} from '../../modules/listings/policy.js';
import { LISTING_ACTIONS, LISTING_MODES, LISTING_STATUSES } from '../../modules/listings/state.js';
import { ANONYMOUS, type ListingService, type Viewer } from '../../modules/listings/service.js';
import type { GuardContext } from '../guard.js';

export interface ListingRouteDeps {
  cfg: GuardConfig;
  listings: ListingService;
  hsts: boolean;
}

const addressBody = v.object({
  addressLine: v.string({ min: 3, max: 200 }),
  unit: v.optional(v.string({ max: 30 })),
  city: v.string({ min: 2, max: 100 }),
  province: v.string({ min: 2, max: 2, pattern: /^[A-Za-z]{2}$/ }),
  postalCode: v.optional(v.string({ max: 10 })),
});

// price_cents is bigint in the schema; the ceiling here keeps it inside a
// safe integer long before it reaches the column's own CHECK.
const priceCents = v.integer({ min: 1, max: 100_000_000_000 - 1 });

const createBody = v.object({
  mode: v.enumOf(LISTING_MODES),
  propertyType: v.enumOf(PROPERTY_TYPES),
  priceCents,
  title: v.string({ min: 3, max: 140 }),
  description: v.optional(v.string({ max: 8000 })),
  descriptionSource: v.optional(v.enumOf(DESCRIPTION_SOURCES)),
  roomType: v.optional(v.enumOf(ROOM_TYPES)),
  beds: v.optional(v.integer({ min: 0, max: 50 })),
  baths: v.optional(v.number({ min: 0, max: 50 })),
  sqft: v.optional(v.integer({ min: 0, max: 100_000 })),
  amenities: v.optional(v.array(v.enumOf(AMENITIES), { max: AMENITIES.length })),
  address: addressBody,
});

// Note what is not here: address, status, ownerId, descriptionAttestedAt.
// `object()` rejects unknown keys, so each omission is an actual refusal.
const updateBody = v.object({
  priceCents: v.optional(priceCents),
  title: v.optional(v.string({ min: 3, max: 140 })),
  description: v.optional(v.string({ max: 8000 })),
  descriptionSource: v.optional(v.enumOf(DESCRIPTION_SOURCES)),
  roomType: v.optional(v.enumOf(ROOM_TYPES)),
  beds: v.optional(v.integer({ min: 0, max: 50 })),
  baths: v.optional(v.number({ min: 0, max: 50 })),
  sqft: v.optional(v.integer({ min: 0, max: 100_000 })),
  amenities: v.optional(v.array(v.enumOf(AMENITIES), { max: AMENITIES.length })),
});

const transitionBody = v.object({
  action: v.enumOf(LISTING_ACTIONS),
  reason: v.optional(v.string({ max: 500 })),
});

const photoBody = v.object({
  mime: v.string({ max: 60 }),
  bytes: v.integer({ min: 1, max: 15 * 1024 * 1024 }),
  kind: v.optional(v.enumOf(['photo', 'tour_3d', 'floorplan'] as const)),
});

const reorderBody = v.object({
  photoIds: v.array(v.uuid(), { max: MAX_PHOTOS }),
});

function ctxOf(requestId: string, origin: string | undefined, deps: ListingRouteDeps): ResponseContext {
  return { requestId, origin, allowedOrigins: deps.cfg.allowedOrigins, hsts: deps.hsts };
}

/** The viewer, derived entirely from the session. Never from the payload. */
function viewerOf(ctx: GuardContext): Viewer {
  if (!ctx.principal) return ANONYMOUS;
  return { userId: ctx.principal.userId, role: ctx.principal.role };
}

/** GET /api/listings/:id — public for live listings, owner/staff otherwise. */
export async function getListing(req: Request, listingId: string, deps: ListingRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: false, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;
    const listing = await deps.listings.get(listingId, viewerOf(ctx));
    return json({ listing }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** GET /api/listings/mine — the caller's own listings, drafts included. */
export async function listMine(req: Request, deps: ListingRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;

    const url = new URL(req.url);
    const status = url.searchParams.get('status');
    if (status !== null && !LISTING_STATUSES.includes(status as never)) {
      // Silently ignoring an unknown filter would return everything, which
      // looks to the caller like the filter matched everything.
      throw badRequest('Request query is invalid.', [
        `status: must be one of: ${LISTING_STATUSES.join(', ')}`,
      ]);
    }
    const listings = await deps.listings.listForOwner(ctx.principal!.userId, {
      limit: toInt(url.searchParams.get('limit'), 50),
      offset: toInt(url.searchParams.get('offset'), 0),
      ...(status ? { status: status as never } : {}),
    });
    return json({ listings }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** POST /api/listings — always creates a draft. */
export async function createListing(req: Request, deps: ListingRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<CreateBody>(req, deps.cfg, {
      requireAuth: true, limit: 'write', body: createBody,
    });
    id = ctx.requestId; origin = ctx.origin;

    const out = await deps.listings.create({
      ownerId: ctx.principal!.userId,   // never from the body
      mode: body.mode,
      propertyType: body.propertyType,
      priceCents: body.priceCents,
      title: body.title,
      description: body.description ?? null,
      ...(body.descriptionSource ? { descriptionSource: body.descriptionSource } : {}),
      roomType: body.roomType ?? null,
      beds: body.beds ?? null,
      baths: body.baths ?? null,
      sqft: body.sqft ?? null,
      amenities: body.amenities ?? [],
      address: {
        addressLine: body.address.addressLine,
        unit: body.address.unit ?? null,
        city: body.address.city,
        province: body.address.province,
        postalCode: body.address.postalCode ?? null,
      },
    });
    return json({ id: out.id, status: 'draft' }, ctxOf(ctx.requestId, ctx.origin, deps), 201);
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** PATCH /api/listings/:id */
export async function updateListing(req: Request, listingId: string, deps: ListingRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<UpdateBody>(req, deps.cfg, {
      requireAuth: true, limit: 'write', body: updateBody,
    });
    id = ctx.requestId; origin = ctx.origin;

    const out = await deps.listings.update(listingId, ctx.principal!.userId, body);
    return json(
      {
        updated: true,
        // Told plainly, because an owner who edits a live listing and is not
        // told it left the search results will assume the site is broken.
        rescanned: out.rescanned,
        ...(out.rescanned
          ? { message: 'Your changes need another review before the listing goes back up.' }
          : {}),
      },
      ctxOf(ctx.requestId, ctx.origin, deps),
    );
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** POST /api/listings/:id/transition — submit, approve, pause, close… */
export async function transitionListing(req: Request, listingId: string, deps: ListingRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ action: never; reason?: string }>(req, deps.cfg, {
      requireAuth: true, limit: 'write', body: transitionBody,
    });
    id = ctx.requestId; origin = ctx.origin;

    const out = await deps.listings.transition(listingId, viewerOf(ctx), body.action,
      body.reason ? { reason: body.reason } : {});
    return json({ status: out.status }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** POST /api/listings/:id/attest — owner accepts an AI-written description. */
export async function attestDescription(req: Request, listingId: string, deps: ListingRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'write' });
    id = ctx.requestId; origin = ctx.origin;
    await deps.listings.attestDescription(listingId, ctx.principal!.userId);
    return noContent(ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** POST /api/listings/:id/photos — reserves a slot, returns an upload ticket. */
export async function addPhoto(req: Request, listingId: string, deps: ListingRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ mime: string; bytes: number; kind?: never }>(req, deps.cfg, {
      requireAuth: true, limit: 'write', body: photoBody,
    });
    id = ctx.requestId; origin = ctx.origin;

    const ticket = await deps.listings.addPhoto(listingId, ctx.principal!.userId, {
      mime: body.mime,
      bytes: body.bytes,
      ...(body.kind ? { kind: body.kind } : {}),
    });
    return json(ticket, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** DELETE /api/listings/:id/photos/:photoId */
export async function removePhoto(
  req: Request, listingId: string, photoId: string, deps: ListingRouteDeps,
): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'write' });
    id = ctx.requestId; origin = ctx.origin;
    await deps.listings.removePhoto(listingId, ctx.principal!.userId, photoId);
    return noContent(ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** PUT /api/listings/:id/photos/order */
export async function reorderPhotos(req: Request, listingId: string, deps: ListingRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ photoIds: string[] }>(req, deps.cfg, {
      requireAuth: true, limit: 'write', body: reorderBody,
    });
    id = ctx.requestId; origin = ctx.origin;
    await deps.listings.reorderPhotos(listingId, ctx.principal!.userId, body.photoIds);
    return noContent(ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

interface CreateBody {
  mode: 'sale' | 'rent';
  propertyType: never;
  priceCents: number;
  title: string;
  description?: string;
  descriptionSource?: never;
  roomType?: never;
  beds?: number;
  baths?: number;
  sqft?: number;
  amenities?: string[];
  address: {
    addressLine: string; unit?: string; city: string;
    province: string; postalCode?: string;
  };
}

type UpdateBody = Omit<Partial<CreateBody>, 'address' | 'mode' | 'propertyType'>;

function toInt(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
