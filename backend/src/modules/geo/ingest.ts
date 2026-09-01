/**
 * Ingest for City of Regina open data.
 *
 * The City serves its datasets through the ArcGIS REST API, which can answer
 * in two shapes depending on the `f` parameter: Esri JSON (`f=json`, the
 * default) and GeoJSON (`f=geojson`, available since ArcGIS 10.4). Both are
 * parsed here, because which one a given layer returns is a property of that
 * layer's configuration rather than something worth assuming.
 *
 * NOTE ON VERIFICATION: outbound access to open.regina.ca is blocked by this
 * environment's network policy, so the parsers below were written against the
 * documented shapes of both formats and are tested against fixtures, NOT
 * against a live response. The field-name mapping in particular is a best
 * effort — ArcGIS layers name their attributes freely — which is why
 * `pickField` searches a list of candidates and why the loader reports what it
 * skipped instead of failing silently. Run `npm run seed:regina -- --dry-run`
 * against the real endpoint before trusting a full load; it prints the first
 * parsed records and the field names it did not recognize.
 *
 * The fetch is injectable for the same reason it is in the notification
 * channels: a network client that cannot be replaced is a module that cannot
 * be tested.
 */
import { normalizeAddress } from '../listings/policy.js';
import {
  bboxOf, centroidOf, inBBox, pointInGeometry,
  type BBox, type GeoJsonGeometry,
} from './polygon.js';
import type { Sql } from '../../db/pool.js';

export const REGINA_SOURCE = 'regina_open_data';

export interface RawAddressPoint {
  sourceId: string;
  civicNumber: string | null;
  streetName: string | null;
  fullAddress: string;
  city: string;
  province: string;
  postalCode: string | null;
  lat: number;
  lng: number;
}

export interface RawBoundary {
  sourceId: string;
  name: string;
  city: string;
  province: string;
  geometry: GeoJsonGeometry;
}

export type SkipReason =
  | 'no_geometry'
  | 'no_address'
  | 'coordinate_out_of_range'
  | 'coordinate_not_in_region'
  | 'no_name';

export interface ParseResult<T> {
  records: T[];
  skipped: Array<{ reason: SkipReason; sourceId: string | null }>;
  /** Attribute names present in the source that nothing mapped to. */
  unmappedFields: string[];
}

// ── field mapping ───────────────────────────────────────────────────────────

/**
 * ArcGIS layers name attributes however their publisher chose, and the same
 * concept appears as ADDRESS, FULL_ADDRESS, ADDR, or CIVIC_ADDRESS across
 * datasets. Rather than hard-coding one guess, each field is looked up
 * against a candidate list, case-insensitively.
 */
const FIELD_CANDIDATES = {
  objectId: ['objectid', 'fid', 'oid', 'globalid', 'id'],
  fullAddress: ['address', 'full_address', 'fulladdress', 'addr', 'civic_address',
                'address_full', 'formatted_address', 'addresslabel'],
  civicNumber: ['civic_num', 'civicnumber', 'house_number', 'housenumber',
                'address_number', 'addressnumber', 'civic_no', 'number'],
  streetName: ['street_name', 'streetname', 'street', 'st_name', 'road_name'],
  postalCode: ['postal_code', 'postalcode', 'postcode', 'zip'],
  city: ['city', 'municipality', 'community', 'town'],
  province: ['province', 'prov', 'state'],
  name: ['name', 'community', 'community_name', 'association', 'neighbourhood',
         'neighborhood', 'label', 'ca_name'],
} as const;

/** Case-insensitive lookup over an attribute bag, first candidate wins. */
export function pickField(
  attrs: Record<string, unknown>,
  candidates: readonly string[],
): { key: string; value: unknown } | null {
  const lower = new Map<string, string>();
  for (const key of Object.keys(attrs)) lower.set(key.toLowerCase(), key);

  for (const want of candidates) {
    const actual = lower.get(want);
    if (actual === undefined) continue;
    const value = attrs[actual];
    if (value === null || value === undefined || value === '') continue;
    return { key: actual, value };
  }
  return null;
}

const asText = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

// ── format detection and normalization ──────────────────────────────────────

interface Feature {
  attributes: Record<string, unknown>;
  geometry: GeoJsonGeometry | null;
}

/**
 * Reduces either response format to a common shape.
 *
 * Esri JSON carries a point as `{x, y}` and a polygon as `rings`; GeoJSON
 * carries both under `geometry.coordinates` with a `type`. Esri rings and
 * GeoJSON polygon coordinates happen to have the same nesting, so a ring
 * array converts directly.
 */
export function toFeatures(payload: unknown): Feature[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const body = payload as Record<string, unknown>;
  const raw = body['features'];
  if (!Array.isArray(raw)) return [];

  return raw.map((f): Feature => {
    const feat = (f ?? {}) as Record<string, unknown>;

    // GeoJSON: properties + a typed geometry.
    if (feat['properties'] !== undefined || feat['type'] === 'Feature') {
      const geom = feat['geometry'] as GeoJsonGeometry | null;
      return {
        attributes: (feat['properties'] ?? {}) as Record<string, unknown>,
        geometry: geom && typeof geom.type === 'string' ? geom : null,
      };
    }

    // Esri JSON: attributes + an untyped geometry.
    const attributes = (feat['attributes'] ?? {}) as Record<string, unknown>;
    const g = feat['geometry'] as Record<string, unknown> | null | undefined;
    if (!g) return { attributes, geometry: null };

    if (typeof g['x'] === 'number' && typeof g['y'] === 'number') {
      return {
        attributes,
        geometry: { type: 'Point', coordinates: [g['x'], g['y']] },
      };
    }
    if (Array.isArray(g['rings'])) {
      // Esri does not distinguish Polygon from MultiPolygon, and does not mark
      // holes by winding in a way worth trusting here. Treating every ring set
      // as one polygon (outer + holes) matches how these boundaries are drawn.
      return { attributes, geometry: { type: 'Polygon', coordinates: g['rings'] } };
    }
    return { attributes, geometry: null };
  });
}

/** True when the server said there is another page to fetch. */
export function hasMore(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const body = payload as Record<string, unknown>;
  // Esri JSON says so directly; GeoJSON output carries it under `properties`.
  if (body['exceededTransferLimit'] === true) return true;
  const props = body['properties'] as Record<string, unknown> | undefined;
  return props?.['exceededTransferLimit'] === true;
}

// ── address points ──────────────────────────────────────────────────────────

export interface ParseAddressOpts {
  /** Rows outside this box are rejected as a projection or axis-order error. */
  region?: BBox | undefined;
  defaultCity?: string;
  defaultProvince?: string;
}

export function parseAddressPoints(
  payload: unknown,
  opts: ParseAddressOpts = {},
): ParseResult<RawAddressPoint> {
  const records: RawAddressPoint[] = [];
  const skipped: ParseResult<RawAddressPoint>['skipped'] = [];
  const mapped = new Set<string>();
  const allKeys = new Set<string>();

  const defaultCity = opts.defaultCity ?? 'Regina';
  const defaultProvince = opts.defaultProvince ?? 'SK';

  for (const feat of toFeatures(payload)) {
    for (const k of Object.keys(feat.attributes)) allKeys.add(k);

    const oid = pickField(feat.attributes, FIELD_CANDIDATES.objectId);
    const sourceId = oid ? asText(oid.value) : null;
    if (oid) mapped.add(oid.key);

    if (!feat.geometry || feat.geometry.type !== 'Point') {
      skipped.push({ reason: 'no_geometry', sourceId });
      continue;
    }
    const coords = feat.geometry.coordinates as [number, number] | undefined;
    const lng = coords?.[0];
    const lat = coords?.[1];
    if (typeof lat !== 'number' || typeof lng !== 'number' ||
        !Number.isFinite(lat) || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      skipped.push({ reason: 'coordinate_out_of_range', sourceId });
      continue;
    }
    // Catches the two silent failures: a projected coordinate system (which
    // lands everything near 0,0 in degrees) and swapped axis order (which
    // puts Regina in the Indian Ocean).
    if (opts.region && !inBBox({ lat, lng }, opts.region)) {
      skipped.push({ reason: 'coordinate_not_in_region', sourceId });
      continue;
    }

    const civic = pickField(feat.attributes, FIELD_CANDIDATES.civicNumber);
    const street = pickField(feat.attributes, FIELD_CANDIDATES.streetName);
    const full = pickField(feat.attributes, FIELD_CANDIDATES.fullAddress);
    const postal = pickField(feat.attributes, FIELD_CANDIDATES.postalCode);
    const city = pickField(feat.attributes, FIELD_CANDIDATES.city);
    const prov = pickField(feat.attributes, FIELD_CANDIDATES.province);
    for (const f of [civic, street, full, postal, city, prov]) if (f) mapped.add(f.key);

    // Prefer the published full address; fall back to composing one, because
    // some layers carry only the parts.
    const civicText = civic ? asText(civic.value) : null;
    const streetText = street ? asText(street.value) : null;
    const fullAddress =
      (full ? asText(full.value) : null) ??
      (civicText && streetText ? `${civicText} ${streetText}` : null);

    if (!fullAddress) {
      skipped.push({ reason: 'no_address', sourceId });
      continue;
    }

    records.push({
      sourceId: sourceId ?? `${lat.toFixed(6)},${lng.toFixed(6)}`,
      civicNumber: civicText,
      streetName: streetText,
      fullAddress,
      city: (city ? asText(city.value) : null) ?? defaultCity,
      province: ((prov ? asText(prov.value) : null) ?? defaultProvince).toUpperCase().slice(0, 2),
      postalCode: postal ? asText(postal.value) : null,
      lat,
      lng,
    });
  }

  return {
    records,
    skipped,
    unmappedFields: [...allKeys].filter((k) => !mapped.has(k)).sort(),
  };
}

// ── boundaries ──────────────────────────────────────────────────────────────

export function parseBoundaries(
  payload: unknown,
  opts: { defaultCity?: string; defaultProvince?: string } = {},
): ParseResult<RawBoundary> {
  const records: RawBoundary[] = [];
  const skipped: ParseResult<RawBoundary>['skipped'] = [];
  const mapped = new Set<string>();
  const allKeys = new Set<string>();

  for (const feat of toFeatures(payload)) {
    for (const k of Object.keys(feat.attributes)) allKeys.add(k);

    const oid = pickField(feat.attributes, FIELD_CANDIDATES.objectId);
    const sourceId = oid ? asText(oid.value) : null;
    if (oid) mapped.add(oid.key);

    if (!feat.geometry || (feat.geometry.type !== 'Polygon' && feat.geometry.type !== 'MultiPolygon')) {
      skipped.push({ reason: 'no_geometry', sourceId });
      continue;
    }
    const name = pickField(feat.attributes, FIELD_CANDIDATES.name);
    if (name) mapped.add(name.key);
    const nameText = name ? asText(name.value) : null;
    if (!nameText) {
      skipped.push({ reason: 'no_name', sourceId });
      continue;
    }
    const city = pickField(feat.attributes, FIELD_CANDIDATES.city);
    const prov = pickField(feat.attributes, FIELD_CANDIDATES.province);
    for (const f of [city, prov]) if (f) mapped.add(f.key);

    records.push({
      sourceId: sourceId ?? nameText,
      name: nameText,
      city: (city ? asText(city.value) : null) ?? opts.defaultCity ?? 'Regina',
      province: ((prov ? asText(prov.value) : null) ?? opts.defaultProvince ?? 'SK')
        .toUpperCase().slice(0, 2),
      geometry: feat.geometry,
    });
  }

  return {
    records,
    skipped,
    unmappedFields: [...allKeys].filter((k) => !mapped.has(k)).sort(),
  };
}

// ── loading ─────────────────────────────────────────────────────────────────

export interface LoadSummary {
  dataset: string;
  seen: number;
  written: number;
  skipped: number;
  skippedByReason: Record<string, number>;
  unmappedFields: string[];
}

/**
 * Writes boundaries, computing each one's bounding box and centre.
 *
 * Upserted by (source, source_id) rather than replaced wholesale: an address
 * point's `neighbourhood_id` points here, and deleting the row to re-insert
 * it would null every reference.
 */
export async function loadBoundaries(
  db: Sql,
  boundaries: readonly RawBoundary[],
  source = REGINA_SOURCE,
): Promise<LoadSummary> {
  let written = 0;
  const skippedByReason: Record<string, number> = {};

  await db.transaction(async (tx) => {
    for (const b of boundaries) {
      const box = bboxOf(b.geometry);
      const centre = centroidOf(b.geometry);
      if (!box || !centre) {
        skippedByReason['no_geometry'] = (skippedByReason['no_geometry'] ?? 0) + 1;
        continue;
      }
      await tx.query(
        `INSERT INTO neighbourhoods
           (name, city, province, boundary, centroid_lat, centroid_lng,
            min_lat, min_lng, max_lat, max_lng, source, source_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (city, province, name) DO UPDATE
           SET boundary = EXCLUDED.boundary,
               centroid_lat = EXCLUDED.centroid_lat,
               centroid_lng = EXCLUDED.centroid_lng,
               min_lat = EXCLUDED.min_lat, min_lng = EXCLUDED.min_lng,
               max_lat = EXCLUDED.max_lat, max_lng = EXCLUDED.max_lng,
               source = EXCLUDED.source, source_id = EXCLUDED.source_id`,
        [
          b.name, b.city, b.province, JSON.stringify(b.geometry),
          centre.lat, centre.lng,
          box.minLat, box.minLng, box.maxLat, box.maxLng,
          source, b.sourceId,
        ],
      );
      written += 1;
    }
  });

  return {
    dataset: 'neighbourhoods',
    seen: boundaries.length,
    written,
    skipped: boundaries.length - written,
    skippedByReason,
    unmappedFields: [],
  };
}

/**
 * Writes address points in batches, assigning each one a neighbourhood.
 *
 * The containment test runs here, once per address, against boundaries held
 * in memory — so no query ever pays for it. Boundaries are checked
 * bounding-box first, which discards almost every candidate with two
 * comparisons before any ray casting happens.
 */
export async function loadAddressPoints(
  db: Sql,
  points: readonly RawAddressPoint[],
  opts: { source?: string; batchSize?: number } = {},
): Promise<LoadSummary> {
  const source = opts.source ?? REGINA_SOURCE;
  const batchSize = Math.min(Math.max(opts.batchSize ?? 500, 1), 2000);

  const hoods = await db.query<{
    id: string; boundary: unknown;
    min_lat: number | null; min_lng: number | null;
    max_lat: number | null; max_lng: number | null;
  }>(
    `SELECT id, boundary, min_lat, min_lng, max_lat, max_lng
       FROM neighbourhoods WHERE boundary IS NOT NULL`,
  );
  const index = hoods.rows.map((h) => ({
    id: h.id,
    geometry: (typeof h.boundary === 'string' ? JSON.parse(h.boundary) : h.boundary) as GeoJsonGeometry,
    box: h.min_lat === null ? null : {
      minLat: h.min_lat, minLng: h.min_lng!, maxLat: h.max_lat!, maxLng: h.max_lng!,
    },
  }));

  let written = 0;
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    await db.transaction(async (tx) => {
      for (const p of batch) {
        await tx.query(
          `INSERT INTO address_points
             (source, source_id, civic_number, street_name, full_address,
              address_norm, city, province, postal_code, lat, lng, neighbourhood_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (source, source_id) DO UPDATE
             SET civic_number = EXCLUDED.civic_number,
                 street_name = EXCLUDED.street_name,
                 full_address = EXCLUDED.full_address,
                 address_norm = EXCLUDED.address_norm,
                 city = EXCLUDED.city, province = EXCLUDED.province,
                 postal_code = EXCLUDED.postal_code,
                 lat = EXCLUDED.lat, lng = EXCLUDED.lng,
                 neighbourhood_id = EXCLUDED.neighbourhood_id,
                 ingested_at = now()`,
          [
            source, p.sourceId, p.civicNumber, p.streetName, p.fullAddress,
            normalizeAddress(p.fullAddress), p.city, p.province, p.postalCode,
            p.lat, p.lng, neighbourhoodFor(p, index),
          ],
        );
        written += 1;
      }
    });
  }

  return {
    dataset: 'address_points',
    seen: points.length,
    written,
    skipped: points.length - written,
    skippedByReason: {},
    unmappedFields: [],
  };
}

interface HoodIndexEntry {
  id: string;
  geometry: GeoJsonGeometry;
  box: BBox | null;
}

/** Bounding box first, ray casting only for the few that survive it. */
export function neighbourhoodFor(
  point: { lat: number; lng: number },
  index: readonly HoodIndexEntry[],
): string | null {
  for (const hood of index) {
    if (hood.box && !inBBox(point, hood.box)) continue;
    if (pointInGeometry(point.lng, point.lat, hood.geometry)) return hood.id;
  }
  return null;
}

/** Records the run, so a dataset that silently halves is visible afterwards. */
export async function recordIngest(
  db: Sql,
  input: {
    source: string; dataset: string; url?: string | null;
    summary: LoadSummary; status?: 'ok' | 'partial' | 'failed';
  },
): Promise<void> {
  await db.query(
    `INSERT INTO gazetteer_ingests
       (source, dataset, fetched_url, rows_seen, rows_written, rows_skipped, status, detail, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())`,
    [
      input.source, input.dataset, input.url ?? null,
      input.summary.seen, input.summary.written, input.summary.skipped,
      input.status ?? (input.summary.skipped > 0 ? 'partial' : 'ok'),
      JSON.stringify({
        skippedByReason: input.summary.skippedByReason,
        unmappedFields: input.summary.unmappedFields,
      }),
    ],
  );
}

// ── fetching ────────────────────────────────────────────────────────────────

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface FetchPagesOpts {
  fetchImpl: FetchLike;
  /** ArcGIS caps a single response; 2000 is the common server maximum. */
  pageSize?: number;
  /** Refuses to run away if the server never stops saying there is more. */
  maxPages?: number;
}

/**
 * Walks an ArcGIS layer with resultOffset paging.
 *
 * Stops when the server stops setting `exceededTransferLimit`, when a page
 * comes back empty, or at `maxPages` — the last of which matters because a
 * misconfigured layer that always reports more would otherwise loop forever.
 */
export async function* fetchArcGisPages(
  baseUrl: string,
  opts: FetchPagesOpts,
): AsyncGenerator<unknown, void, undefined> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 1000, 1), 2000);
  const maxPages = opts.maxPages ?? 200;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(baseUrl);
    url.searchParams.set('where', url.searchParams.get('where') ?? '1=1');
    url.searchParams.set('outFields', url.searchParams.get('outFields') ?? '*');
    url.searchParams.set('f', url.searchParams.get('f') ?? 'geojson');
    url.searchParams.set('outSR', '4326');
    url.searchParams.set('resultOffset', String(page * pageSize));
    url.searchParams.set('resultRecordCount', String(pageSize));

    const res = await opts.fetchImpl(url.toString());
    if (!res.ok) {
      throw new Error(`Regina open data returned ${res.status} for ${url.pathname}`);
    }
    const body = await res.json();
    yield body;

    const features = toFeatures(body);
    if (features.length === 0 || !hasMore(body)) return;
  }
}
