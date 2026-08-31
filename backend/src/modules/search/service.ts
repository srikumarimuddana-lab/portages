/**
 * Search service.
 *
 * Runs a validated FilterSpec and returns a page plus the cursor for the next
 * one. Photos for the whole page are fetched in one query — the per-card
 * version of that is the N+1 that turns a 40 ms search into a 400 ms one as
 * soon as results have pictures.
 */
import { buildSearch, cursorKeyOf } from './query.js';
import {
  encodeCursor, filterSpecSchema, validateSpec, withDefaults,
  type FilterSpec, type SortOrder,
} from './spec.js';
import { badRequest } from '../../lib/errors.js';
import type { Sql } from '../../db/pool.js';

export interface SearchResultCard {
  id: string;
  mode: string;
  priceCents: number;
  propertyType: string;
  roomType: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  amenities: string[];
  title: string;
  /** Trimmed for a card; the full text is on the listing page. */
  summary: string | null;
  publishedAt: Date | null;
  address: {
    addressLine: string;
    unit: string | null;
    city: string;
    province: string;
    postalCode: string | null;
    lat: number | null;
    lng: number | null;
  };
  neighbourhoodId: string | null;
  photo: { storageKey: string; mime: string } | null;
  /** Present when the search had a centre. */
  distanceM?: number;
}

export interface SearchPage {
  results: SearchResultCard[];
  /** Absent when this is the last page. */
  nextCursor?: string;
  sort: SortOrder;
}

const SUMMARY_CHARS = 240;

export class SearchService {
  readonly #db: Sql;

  constructor(db: Sql) {
    this.#db = db;
  }

  /**
   * Parses and validates an untrusted spec.
   *
   * Separate from `run` so the AI path and the HTTP path share exactly one
   * definition of what a valid search is — and so a caller that already holds
   * a validated spec is not forced to re-serialize it to get it checked.
   */
  parse(input: unknown): FilterSpec & { sort: SortOrder; limit: number } {
    const parsed = filterSpecSchema.parse(input);
    if (!parsed.ok) throw badRequest('Search filters are invalid.', parsed.errors);

    const spec = parsed.value as FilterSpec;
    const problems = validateSpec(spec);
    if (problems.length > 0) throw badRequest('Search filters are invalid.', problems);

    return withDefaults(spec);
  }

  async search(input: unknown): Promise<SearchPage> {
    return this.run(this.parse(input));
  }

  /** Runs an already-validated spec. */
  async run(spec: FilterSpec & { sort: SortOrder; limit: number }): Promise<SearchPage> {
    const { text, params } = buildSearch(spec);
    const res = await this.#db.query<SearchRow>(text, params);

    // One row over the limit was requested; its presence is the only thing
    // that says another page exists, and it is not itself returned.
    const hasMore = res.rows.length > spec.limit;
    const rows = hasMore ? res.rows.slice(0, spec.limit) : res.rows;
    if (rows.length === 0) return { results: [], sort: spec.sort };

    const photos = await this.#coverPhotos(rows.map((r) => r.id));
    const centre = spec.near ? { lat: spec.near.lat, lng: spec.near.lng } : null;

    const results = rows.map((r): SearchResultCard => {
      const card: SearchResultCard = {
        id: r.id,
        mode: r.mode,
        priceCents: Number(r.price_cents),
        propertyType: r.property_type,
        roomType: r.room_type,
        beds: r.beds,
        baths: r.baths === null ? null : Number(r.baths),
        sqft: r.sqft,
        amenities: r.amenities,
        title: r.title,
        summary: summarize(r.description),
        publishedAt: r.published_at,
        address: {
          addressLine: r.address_line,
          unit: r.unit,
          city: r.city,
          province: r.province,
          postalCode: r.postal_code,
          lat: r.lat,
          lng: r.lng,
        },
        neighbourhoodId: r.neighbourhood_id,
        photo: photos.get(r.id) ?? null,
      };
      if (centre && r.lat !== null && r.lng !== null) {
        card.distanceM = Math.round(haversine(centre, { lat: r.lat, lng: r.lng }));
      }
      return card;
    });

    const last = rows[rows.length - 1]!;
    return {
      results,
      sort: spec.sort,
      ...(hasMore
        ? { nextCursor: encodeCursor({ k: cursorKeyOf(spec.sort, last), id: last.id }) }
        : {}),
    };
  }

  /**
   * The first photo for each listing on the page, in one query.
   *
   * DISTINCT ON is the cheapest way to take one row per group in Postgres,
   * and it reads straight down listing_media_listing_idx, which is already
   * ordered (listing_id, position).
   */
  async #coverPhotos(listingIds: readonly string[]): Promise<Map<string, { storageKey: string; mime: string }>> {
    const out = new Map<string, { storageKey: string; mime: string }>();
    if (listingIds.length === 0) return out;

    const res = await this.#db.query<{ listing_id: string; storage_key: string; mime: string }>(
      `SELECT DISTINCT ON (listing_id) listing_id, storage_key, mime
         FROM listing_media
        WHERE listing_id = ANY($1::uuid[]) AND kind = 'photo'
        ORDER BY listing_id, position, id`,
      [listingIds as string[]],
    );
    for (const r of res.rows) {
      out.set(r.listing_id, { storageKey: r.storage_key, mime: r.mime });
    }
    return out;
  }

  /**
   * Counts matches for a spec, ignoring pagination.
   *
   * Kept separate from `run` and deliberately not called by it: an exact total
   * is a full scan of the matching set, which is fine for "how many homes
   * match this saved search" and wasteful on every page of a browse.
   */
  async count(spec: FilterSpec & { sort: SortOrder; limit: number }): Promise<number> {
    const { text, params } = buildSearch(spec, { forCount: true });
    const res = await this.#db.query<{ n: string }>(text, params);
    return Number(res.rows[0]?.n ?? 0);
  }
}

interface SearchRow {
  id: string;
  mode: string;
  status: string;
  price_cents: string;
  property_type: string;
  room_type: string | null;
  beds: number | null;
  baths: string | null;
  sqft: number | null;
  amenities: string[];
  title: string;
  description: string | null;
  published_at: Date | null;
  created_at: Date;
  address_line: string;
  unit: string | null;
  city: string;
  province: string;
  postal_code: string | null;
  lat: number | null;
  lng: number | null;
  neighbourhood_id: string | null;
  sort_key: unknown;
  rank?: number;
}

/** Cuts on a word boundary, so a card never ends mid-word. */
function summarize(description: string | null): string | null {
  if (!description) return null;
  const flat = description.replace(/\s+/g, ' ').trim();
  if (flat.length <= SUMMARY_CHARS) return flat;
  const cut = flat.slice(0, SUMMARY_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > SUMMARY_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const EARTH_RADIUS_M = 6_371_008.8;
function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}
