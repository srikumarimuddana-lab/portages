/**
 * The gazetteer: address autocomplete and coordinate resolution.
 *
 * This is what replaces a geocoding API. Every query runs against the City of
 * Regina address points already in our database, which means no per-request
 * cost, no rate limit to design around, no licence question about storing the
 * result, and — for one city — better accuracy than any global geocoder.
 *
 * It is also what keeps us off `mapkit.Search`, whose 25,000 service calls a
 * day come with no overage tier and no way to buy more.
 */
import { normalizeAddress, propertyKey } from '../listings/policy.js';
import { boundingBoxFor, haversineMetres, REGINA_BBOX, type BBox } from './polygon.js';
import type { Sql } from '../../db/pool.js';

/**
 * pg_trgm's own default for the `%` operator. Named here so the code says
 * what the fuzzy branch actually cuts at, rather than leaving it as an
 * invisible database setting.
 */
export const OPERATOR_SIMILARITY_THRESHOLD = 0.3;
export const MAX_SUGGESTIONS = 10;
/** Shorter than this and the trigram index cannot narrow anything useful. */
export const MIN_QUERY_LENGTH = 3;

export interface Suggestion {
  id: string;
  address: string;
  city: string;
  province: string;
  postalCode: string | null;
  lat: number;
  lng: number;
  neighbourhood: string | null;
  /** 0–1. Exposed so a client can decide whether to auto-select the top hit. */
  score: number;
}

export interface ResolvedAddress {
  addressPointId: string;
  lat: number;
  lng: number;
  neighbourhoodId: string | null;
  postalCode: string | null;
  /** How the match was made — 'exact' is a normalized-key hit. */
  confidence: 'exact' | 'fuzzy';
}

export class Gazetteer {
  readonly #db: Sql;

  constructor(db: Sql) {
    this.#db = db;
  }

  /**
   * Address suggestions for a partial input.
   *
   * Two predicates, both served by the same GIN trigram index, because
   * neither alone is enough:
   *
   *   LIKE 'prefix%'  — carries the early keystrokes. Measured against real
   *                     pg_trgm: similarity('123 victoria avenue', '123 vic')
   *                     is 0.333, but '123 vi' is 0.286 and '123 v' is 0.238,
   *                     both under the operator's 0.3 default. So `%` alone
   *                     returns NOTHING until the seventh character — which is
   *                     precisely the stretch autocomplete exists to serve.
   *
   *   address_norm % q — carries typos and mid-string matches. Someone typing
   *                     "victoria" with no civic number scores 0.45 and is
   *                     found, where a prefix match would miss entirely.
   *
   * `similarity()` then ranks what survives, with a prefix hit sorted above a
   * fuzzy one: a person typing "123 vic" means an address that STARTS that
   * way, and trigram similarity alone cannot tell a prefix from a middle.
   *
   * The two run as SEPARATE CTEs rather than one `OR`, which is not a
   * stylistic choice. Measured on 70k rows: `LIKE` alone takes a bitmap index
   * scan at 3.8 ms, but `LIKE … OR … %` makes the planner give up and
   * sequential-scan the table at 155 ms. Split into two scans and unioned, the
   * whole query is 16 ms. See test/sql/gazetteer.sql, which asserts that
   * neither branch has silently reverted to a sequential scan.
   */
  async suggest(input: {
    query: string;
    limit?: number;
    city?: string | undefined;
    province?: string | undefined;
  }): Promise<Suggestion[]> {
    const norm = normalizeAddress(input.query);
    if (norm.length < MIN_QUERY_LENGTH) return [];
    const limit = Math.min(Math.max(input.limit ?? 8, 1), MAX_SUGGESTIONS);

    const res = await this.#db.query<{
      id: string; full_address: string; city: string; province: string;
      postal_code: string | null; lat: number; lng: number;
      neighbourhood: string | null; score: number;
    }>(
      `WITH prefix AS (
         SELECT id, 2 AS tier
           FROM address_points
          WHERE address_norm LIKE $5
            AND ($3::text IS NULL OR city = $3)
            AND ($4::text IS NULL OR province = $4)
          ORDER BY length(address_norm), id
          LIMIT $6
       ), fuzzy AS (
         SELECT id, 1 AS tier
           FROM address_points
          WHERE address_norm % $1
            AND ($3::text IS NULL OR city = $3)
            AND ($4::text IS NULL OR province = $4)
          ORDER BY similarity(address_norm, $1) DESC, id
          LIMIT $6
       ), hits AS (
         SELECT id, max(tier) AS tier
           FROM (SELECT * FROM prefix UNION ALL SELECT * FROM fuzzy) u
          GROUP BY id
       )
       SELECT a.id, a.full_address, a.city, a.province, a.postal_code,
              a.lat, a.lng, n.name AS neighbourhood,
              similarity(a.address_norm, $1) AS score
         FROM hits h
         JOIN address_points a ON a.id = h.id
         LEFT JOIN neighbourhoods n ON n.id = a.neighbourhood_id
        ORDER BY h.tier DESC,
                 similarity(a.address_norm, $1) DESC,
                 length(a.address_norm) ASC,
                 a.id
        LIMIT $2`,
      [
        norm,
        limit,
        input.city ?? null,
        input.province ?? null,
        // The input is normalized to [a-z0-9 ] by normalizeAddress, so no LIKE
        // metacharacter survives to reach this — escaped anyway rather than
        // relying on a guarantee made in another file.
        `${escapeLike(norm)}%`,
        // Each branch gathers more than the caller asked for, so that ranking
        // across the union has something to choose between.
        limit * 3,
      ],
    );

    // No score filter here: the WHERE clause already decided membership, and
    // a prefix hit is legitimately allowed to score below the fuzzy floor.
    return res.rows
      .map((r) => ({
        id: r.id,
        address: r.full_address,
        city: r.city,
        province: r.province,
        postalCode: r.postal_code,
        lat: r.lat,
        lng: r.lng,
        neighbourhood: r.neighbourhood,
        score: Number(r.score),
      }));
  }

  /**
   * Resolves a listing's typed address to an authoritative coordinate.
   *
   * Exact first, on the same normalized key the listings table uses. A fuzzy
   * fallback follows, but only above a high similarity floor: attaching the
   * wrong coordinate to a listing is worse than attaching none, because a pin
   * on the wrong house looks authoritative and a missing pin looks missing.
   */
  async resolve(input: {
    addressLine: string;
    unit?: string | null;
    city: string;
    province: string;
  }): Promise<ResolvedAddress | null> {
    // The unit is dropped for gazetteer lookup: civic address points identify
    // buildings, not suites, so "123 Main, unit 4" resolves via "123 Main".
    const norm = normalizeAddress(input.addressLine);
    if (!norm) return null;

    const exact = await this.#db.query<{
      id: string; lat: number; lng: number;
      neighbourhood_id: string | null; postal_code: string | null;
    }>(
      `SELECT id, lat, lng, neighbourhood_id, postal_code
         FROM address_points
        WHERE address_norm = $1 AND city = $2 AND province = $3
        ORDER BY id
        LIMIT 1`,
      [norm, input.city.trim(), input.province.toUpperCase()],
    );
    if (exact.rows[0]) {
      const r = exact.rows[0];
      return {
        addressPointId: r.id,
        lat: r.lat,
        lng: r.lng,
        neighbourhoodId: r.neighbourhood_id,
        postalCode: r.postal_code,
        confidence: 'exact',
      };
    }

    const FUZZY_FLOOR = 0.55;
    const fuzzy = await this.#db.query<{
      id: string; lat: number; lng: number;
      neighbourhood_id: string | null; postal_code: string | null; score: number;
    }>(
      `SELECT id, lat, lng, neighbourhood_id, postal_code,
              similarity(address_norm, $1) AS score
         FROM address_points
        WHERE address_norm % $1 AND city = $2 AND province = $3
        ORDER BY similarity(address_norm, $1) DESC, id
        LIMIT 1`,
      [norm, input.city.trim(), input.province.toUpperCase()],
    );
    const best = fuzzy.rows[0];
    if (!best || Number(best.score) < FUZZY_FLOOR) return null;

    return {
      addressPointId: best.id,
      lat: best.lat,
      lng: best.lng,
      neighbourhoodId: best.neighbourhood_id,
      postalCode: best.postal_code,
      confidence: 'fuzzy',
    };
  }

  /** Neighbourhood boundaries, for MapKit `importGeoJSON` overlays. */
  async neighbourhoods(city = 'Regina', province = 'SK'): Promise<Array<{
    id: string; name: string; centroid: { lat: number; lng: number } | null;
    bbox: BBox | null; boundary: unknown;
  }>> {
    const res = await this.#db.query<{
      id: string; name: string; boundary: unknown;
      centroid_lat: number | null; centroid_lng: number | null;
      min_lat: number | null; min_lng: number | null;
      max_lat: number | null; max_lng: number | null;
    }>(
      `SELECT id, name, boundary, centroid_lat, centroid_lng,
              min_lat, min_lng, max_lat, max_lng
         FROM neighbourhoods
        WHERE city = $1 AND province = $2
        ORDER BY name`,
      [city, province],
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      centroid: r.centroid_lat === null || r.centroid_lng === null
        ? null
        : { lat: r.centroid_lat, lng: r.centroid_lng },
      bbox: r.min_lat === null ? null : {
        minLat: r.min_lat, minLng: r.min_lng!, maxLat: r.max_lat!, maxLng: r.max_lng!,
      },
      boundary: r.boundary,
    }));
  }

  /**
   * Address points within a radius, nearest first.
   *
   * The bounding box is the part that uses an index; the haversine that
   * follows is exact but unindexable, so it only ever runs over what the box
   * already narrowed.
   */
  async near(centre: { lat: number; lng: number }, radiusM: number, limit = 25): Promise<Array<Suggestion & { distanceM: number }>> {
    const box = boundingBoxFor(centre, Math.min(Math.max(radiusM, 1), 50_000));
    const res = await this.#db.query<{
      id: string; full_address: string; city: string; province: string;
      postal_code: string | null; lat: number; lng: number; neighbourhood: string | null;
    }>(
      `SELECT a.id, a.full_address, a.city, a.province, a.postal_code,
              a.lat, a.lng, n.name AS neighbourhood
         FROM address_points a
         LEFT JOIN neighbourhoods n ON n.id = a.neighbourhood_id
        WHERE a.lat BETWEEN $1 AND $2 AND a.lng BETWEEN $3 AND $4
        LIMIT $5`,
      [box.minLat, box.maxLat, box.minLng, box.maxLng, Math.min(limit * 40, 5000)],
    );

    return res.rows
      .map((r) => ({
        id: r.id,
        address: r.full_address,
        city: r.city,
        province: r.province,
        postalCode: r.postal_code,
        lat: r.lat,
        lng: r.lng,
        neighbourhood: r.neighbourhood,
        score: 1,
        distanceM: haversineMetres(centre, { lat: r.lat, lng: r.lng }),
      }))
      .filter((r) => r.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, limit);
  }

  /** How many points are loaded, and when. Drives an ops health check. */
  async health(): Promise<{ addressPoints: number; neighbourhoods: number; lastIngestAt: Date | null }> {
    const res = await this.#db.query<{ points: string; hoods: string; last: Date | null }>(
      `SELECT (SELECT count(*) FROM address_points)::text AS points,
              (SELECT count(*) FROM neighbourhoods WHERE boundary IS NOT NULL)::text AS hoods,
              (SELECT max(finished_at) FROM gazetteer_ingests WHERE status <> 'failed') AS last`,
    );
    const row = res.rows[0];
    return {
      addressPoints: Number(row?.points ?? 0),
      neighbourhoods: Number(row?.hoods ?? 0),
      lastIngestAt: row?.last ?? null,
    };
  }
}

/** Escapes LIKE metacharacters. Belt and braces — the input is already [a-z0-9 ]. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export { REGINA_BBOX, propertyKey };
