/**
 * The small amount of geometry Portage needs, done without PostGIS.
 *
 * PostGIS is the right answer for polygon SEARCH — a user dragging a shape
 * across a map — and that is what enabling it is for. It is the wrong answer
 * for the one job here: deciding, once per address at ingest time, which
 * neighbourhood a point falls in. That is 70k evaluations, run when the
 * dataset changes, against about a hundred polygons. Doing it in the
 * application keeps the containment test out of every query and off the
 * critical path entirely.
 *
 * Everything in this file is pure and closed-form, so it is testable against
 * hand-worked examples rather than against a spatial engine.
 */

export type Position = readonly [number, number]; // [lng, lat], GeoJSON order
export type LinearRing = readonly Position[];
/** First ring is the outer boundary; any further rings are holes. */
export type PolygonRings = readonly LinearRing[];

export interface BBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface GeoJsonGeometry {
  type: string;
  coordinates?: unknown;
}

/**
 * Point-in-polygon by ray casting.
 *
 * Counts crossings of a ray cast from the point along +longitude. Odd means
 * inside. The `(yi > lat) !== (yj > lat)` test uses strict-above on both ends,
 * which is what makes a vertex lying exactly on the ray count once rather
 * than twice — the classic double-count bug in this algorithm.
 *
 * Holes are handled by the caller's rule: inside the outer ring and inside
 * any hole means outside the polygon.
 */
export function pointInRing(lng: number, lat: number, ring: LinearRing): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i]!;
    const pj = ring[j]!;
    const xi = pi[0], yi = pi[1];
    const xj = pj[0], yj = pj[1];

    if ((yi > lat) !== (yj > lat)) {
      // Longitude where edge (j -> i) crosses this latitude.
      const cross = (xj - xi) * (lat - yi) / (yj - yi) + xi;
      if (lng < cross) inside = !inside;
    }
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function pointInPolygon(lng: number, lat: number, rings: PolygonRings): boolean {
  const outer = rings[0];
  if (!outer || outer.length < 3) return false;
  if (!pointInRing(lng, lat, outer)) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lng, lat, rings[i]!)) return false;
  }
  return true;
}

/** Handles Polygon and MultiPolygon; anything else is not a containment test. */
export function pointInGeometry(lng: number, lat: number, geom: GeoJsonGeometry): boolean {
  if (geom.type === 'Polygon') {
    return pointInPolygon(lng, lat, geom.coordinates as PolygonRings);
  }
  if (geom.type === 'MultiPolygon') {
    const parts = geom.coordinates as readonly PolygonRings[];
    return parts.some((rings) => pointInPolygon(lng, lat, rings));
  }
  return false;
}

/** Bounding box of any GeoJSON geometry, or null if it carries no positions. */
export function bboxOf(geom: GeoJsonGeometry): BBox | null {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  let seen = false;

  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    // A position is [lng, lat] — two or more numbers, numbers at the front.
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      const lng = node[0] as number;
      const lat = node[1] as number;
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        seen = true;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
      return;
    }
    for (const child of node) walk(child);
  };
  walk(geom.coordinates);

  return seen ? { minLat, minLng, maxLat, maxLng } : null;
}

/** Area-weighted-ish centre: the mean of the outer ring's vertices. */
export function centroidOf(geom: GeoJsonGeometry): { lat: number; lng: number } | null {
  const box = bboxOf(geom);
  if (!box) return null;
  // The bounding-box centre, not a true centroid. It is used to place a label
  // and to sort by rough proximity, never to measure anything, and for the
  // compact neighbourhood polygons here the difference is metres.
  return {
    lat: (box.minLat + box.maxLat) / 2,
    lng: (box.minLng + box.maxLng) / 2,
  };
}

// ── distance ────────────────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean radius

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * A bounding box that contains every point within `radiusM` of the centre.
 *
 * This is the index-usable prefilter: `lat BETWEEN … AND lng BETWEEN …` hits
 * the btree, and the exact haversine then runs over the handful of rows that
 * survive. Without it a radius search reads every row in the table.
 *
 * The box is a superset of the circle, never a subset — the exact test after
 * it removes the corners, so erring wide is correct and erring narrow would
 * silently drop results.
 */
export function boundingBoxFor(centre: { lat: number; lng: number }, radiusM: number): BBox {
  const latDelta = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);

  // Longitude degrees shrink with latitude. At Regina's 50.45°N a degree of
  // longitude is about 71 km against 111 km for a degree of latitude, so
  // using the latitude figure for both would cut the box's width by a third.
  const cos = Math.cos(toRad(centre.lat));
  const lngDelta =
    Math.abs(cos) < 1e-9
      ? 180 // at a pole, every longitude is within reach
      : (radiusM / (EARTH_RADIUS_M * cos)) * (180 / Math.PI);

  return {
    minLat: Math.max(-90, centre.lat - latDelta),
    maxLat: Math.min(90, centre.lat + latDelta),
    minLng: Math.max(-180, centre.lng - lngDelta),
    maxLng: Math.min(180, centre.lng + lngDelta),
  };
}

/** True when the point falls inside the box. Boundaries count as inside. */
export function inBBox(point: { lat: number; lng: number }, box: BBox): boolean {
  return (
    point.lat >= box.minLat && point.lat <= box.maxLat &&
    point.lng >= box.minLng && point.lng <= box.maxLng
  );
}

/**
 * Regina's extent, used to reject coordinates that cannot be right.
 *
 * A civic address point outside this box means the source data changed shape
 * — a projection mix-up puts everything near (0,0), and swapped lat/lng puts
 * Regina in the Indian Ocean. Both are silent failures without a check.
 */
export const REGINA_BBOX: BBox = {
  minLat: 50.35,
  maxLat: 50.58,
  minLng: -104.78,
  maxLng: -104.42,
};

/** A generous Saskatchewan box, for data that legitimately reaches past the city. */
export const SASKATCHEWAN_BBOX: BBox = {
  minLat: 48.9,
  maxLat: 60.1,
  minLng: -110.1,
  maxLng: -101.2,
};
