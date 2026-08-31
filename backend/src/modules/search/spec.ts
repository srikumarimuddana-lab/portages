/**
 * The search filter specification.
 *
 * This type is the contract between everything that wants to search and the
 * one place allowed to build listing SQL. It exists so that "search" has a
 * shape a program can reason about rather than being a string that gets
 * concatenated.
 *
 * It matters most for the AI path. A chat search assistant emits a FilterSpec
 * and nothing else — it never writes SQL, never names a column, and never
 * returns a listing it invented, because the only thing it can produce is a
 * value of this type, which is then validated like any other untrusted input
 * before a query is built from it. A model that cannot express a query cannot
 * express an injection.
 */
import * as v from '../../lib/validate.js';
import { AMENITIES, PROPERTY_TYPES, ROOM_TYPES } from '../listings/policy.js';
import { LISTING_MODES } from '../listings/state.js';

export const SORT_ORDERS = ['newest', 'price_asc', 'price_desc', 'relevance'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export const DEFAULT_LIMIT = 24;
export const MAX_LIMIT = 60;
/** A radius beyond this is a city-wide search; say so with a bbox instead. */
export const MAX_RADIUS_M = 50_000;

export interface BoundingBoxSpec {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface NearSpec {
  lat: number;
  lng: number;
  radiusM: number;
}

export interface FilterSpec {
  mode?: 'sale' | 'rent';
  propertyTypes?: string[];
  roomType?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  minBeds?: number;
  maxBeds?: number;
  minBaths?: number;
  minSqft?: number;
  maxSqft?: number;
  /** AND semantics: a listing must carry every one of these. */
  amenities?: string[];
  neighbourhoodIds?: string[];
  city?: string;
  province?: string;
  bbox?: BoundingBoxSpec;
  near?: NearSpec;
  /** Free text, matched against the listing's search_text. */
  q?: string;
  sort?: SortOrder;
  cursor?: string;
  limit?: number;
}

// Latitude and longitude are validated as numbers in range here, so the query
// builder never has to consider whether a coordinate is a coordinate.
const lat = v.number({ min: -90, max: 90 });
const lng = v.number({ min: -180, max: 180 });

export const bboxSchema = v.object({
  minLat: lat, minLng: lng, maxLat: lat, maxLng: lng,
});

export const nearSchema = v.object({
  lat, lng,
  radiusM: v.number({ min: 1, max: MAX_RADIUS_M }),
});

/**
 * The schema every search request is parsed through, whoever sent it.
 *
 * `v.object` rejects unknown keys, so a spec carrying a field this schema does
 * not name is refused outright rather than having the extra quietly dropped —
 * which is what stops a future column from becoming filterable by accident.
 */
export const filterSpecSchema = v.object({
  mode: v.optional(v.enumOf(LISTING_MODES)),
  propertyTypes: v.optional(v.array(v.enumOf(PROPERTY_TYPES), { max: PROPERTY_TYPES.length })),
  roomType: v.optional(v.enumOf(ROOM_TYPES)),
  minPriceCents: v.optional(v.integer({ min: 0, max: 100_000_000_000 })),
  maxPriceCents: v.optional(v.integer({ min: 0, max: 100_000_000_000 })),
  minBeds: v.optional(v.integer({ min: 0, max: 50 })),
  maxBeds: v.optional(v.integer({ min: 0, max: 50 })),
  minBaths: v.optional(v.number({ min: 0, max: 50 })),
  minSqft: v.optional(v.integer({ min: 0, max: 100_000 })),
  maxSqft: v.optional(v.integer({ min: 0, max: 100_000 })),
  amenities: v.optional(v.array(v.enumOf(AMENITIES), { max: AMENITIES.length })),
  neighbourhoodIds: v.optional(v.array(v.uuid(), { max: 40 })),
  city: v.optional(v.string({ min: 2, max: 100 })),
  province: v.optional(v.string({ min: 2, max: 2, pattern: /^[A-Za-z]{2}$/ })),
  bbox: v.optional(bboxSchema),
  near: v.optional(nearSchema),
  q: v.optional(v.string({ min: 1, max: 200 })),
  sort: v.optional(v.enumOf(SORT_ORDERS)),
  cursor: v.optional(v.string({ max: 400 })),
  limit: v.optional(v.integer({ min: 1, max: MAX_LIMIT })),
});

export type SpecProblem = string;

/**
 * Checks the things a per-field schema cannot see: relationships between
 * fields.
 *
 * Inverted ranges are the interesting case. `minPrice > maxPrice` is not a
 * type error and produces a perfectly valid query that returns nothing — so
 * without this the user gets an empty result page and no idea why.
 */
export function validateSpec(spec: FilterSpec): SpecProblem[] {
  const problems: SpecProblem[] = [];

  if (spec.minPriceCents !== undefined && spec.maxPriceCents !== undefined &&
      spec.minPriceCents > spec.maxPriceCents) {
    problems.push('minPriceCents must not be greater than maxPriceCents.');
  }
  if (spec.minBeds !== undefined && spec.maxBeds !== undefined && spec.minBeds > spec.maxBeds) {
    problems.push('minBeds must not be greater than maxBeds.');
  }
  if (spec.minSqft !== undefined && spec.maxSqft !== undefined && spec.minSqft > spec.maxSqft) {
    problems.push('minSqft must not be greater than maxSqft.');
  }
  if (spec.bbox) {
    if (spec.bbox.minLat > spec.bbox.maxLat) problems.push('bbox.minLat must not exceed bbox.maxLat.');
    // Longitude deliberately not checked for inversion: a box spanning the
    // antimeridian legitimately has minLng > maxLng. The query builder splits
    // that case rather than treating it as an error.
  }
  if (spec.bbox && spec.near) {
    problems.push('Give either bbox or near, not both.');
  }
  if (spec.roomType && spec.mode === 'sale') {
    problems.push('roomType applies to rentals only.');
  }
  if (spec.sort === 'relevance' && !spec.q) {
    problems.push('sort=relevance needs a query in q.');
  }
  return problems;
}

/** Applies the defaults, so the query builder never sees an absent sort or limit. */
export function withDefaults(spec: FilterSpec): FilterSpec & { sort: SortOrder; limit: number } {
  return {
    ...spec,
    sort: spec.sort ?? (spec.q ? 'relevance' : 'newest'),
    limit: Math.min(Math.max(spec.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT),
  };
}

// ── cursors ─────────────────────────────────────────────────────────────────

/**
 * A keyset cursor: the sort key of the last row on the previous page.
 *
 * Deliberately NOT signed or encrypted. It carries only values that are
 * already public — the price or publish date of a live listing and its id —
 * and it confers nothing: a forged cursor can only move the window within
 * results the caller could already page to. Signing it would imply a
 * confidentiality it does not have.
 *
 * It is still validated strictly on decode, because a cursor whose shape does
 * not match the sort would produce a comparison against the wrong column.
 */
export interface Cursor {
  /** The primary sort value: epoch millis, cents, or a relevance rank. */
  k: number;
  /** The tiebreaker, always the listing id. */
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Returns null for anything malformed; a bad cursor starts from the top. */
export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    // Bound the decoded text too: base64url of a huge string is still a huge
    // string, and JSON.parse on it is work done before anything is validated.
    if (json.length > 400) return null;
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const c = parsed as Record<string, unknown>;
    if (typeof c['k'] !== 'number' || !Number.isFinite(c['k'])) return null;
    if (typeof c['id'] !== 'string' || !UUID_RE.test(c['id'])) return null;
    return { k: c['k'], id: c['id'].toLowerCase() };
  } catch {
    return null;
  }
}
