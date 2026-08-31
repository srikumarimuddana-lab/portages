/**
 * The ONLY place in Portage that builds listing SQL.
 *
 * Everything that searches — the browse page, the map viewport, saved-search
 * alerts, the AI chat assistant — comes through here with a validated
 * FilterSpec. Concentrating it has one purpose: there is exactly one function
 * to read to know what a search can and cannot do.
 *
 * The injection guarantee is structural, not a matter of care:
 *
 *   - Every value goes in as a numbered parameter. `param()` is the only way
 *     to get a value into the string, and it always returns `$n`.
 *   - No identifier ever comes from input. Column and direction come from a
 *     switch over a closed union, so an unlisted sort cannot name a column.
 *   - Array membership uses `= ANY($n)` rather than a built IN list, so the
 *     number of parameters does not depend on the number of values.
 *
 * A caller could pass a FilterSpec that never went through filterSpecSchema.
 * That still cannot inject, because nothing here interpolates — but it could
 * filter on a value the schema would have rejected, which is why the service
 * validates before calling and the routes validate before that.
 */
import {
  boundingBoxFor, type BBox,
} from '../geo/polygon.js';
import { decodeCursor, type Cursor, type FilterSpec, type SortOrder } from './spec.js';

export interface BuiltQuery {
  text: string;
  params: unknown[];
}

/** Accumulates parameters so a value can only ever enter the SQL as `$n`. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * The sort orders, each mapped to a fixed column expression and direction.
 *
 * This table is why a sort cannot inject: `SortOrder` is a closed union, the
 * lookup is total, and every value on the right is a literal written here.
 * Each entry also names the index it is meant to use — if a sort is added
 * without one, the pagination gets slower with every page rather than failing
 * visibly, which is the kind of regression nobody notices for a month.
 */
const SORTS: Record<SortOrder, {
  /** SQL expression for the primary sort key. */
  expr: string;
  direction: 'ASC' | 'DESC';
  /** Turns a row's key into the number a cursor carries. */
  index: string;
}> = {
  newest:     { expr: 'l.published_at', direction: 'DESC', index: 'listings_recent_idx' },
  price_asc:  { expr: 'l.price_cents',  direction: 'ASC',  index: 'listings_price_asc_idx' },
  // Both price sorts name the SAME index: a btree scanned backward answers
  // the descending order, so a second index would be pure write cost.
  price_desc: { expr: 'l.price_cents',  direction: 'DESC', index: 'listings_price_asc_idx' },
  relevance:  { expr: 'rank',           direction: 'DESC', index: 'listings_fts_idx' },
};

/**
 * Builds the search query and a matching count-free page fetch.
 *
 * `limit + 1` rows are requested so the caller can tell whether another page
 * exists without running a second query or a COUNT — at any real catalogue
 * size, a total count costs more than the page it decorates.
 */
export function buildSearch(
  spec: FilterSpec & { sort: SortOrder; limit: number },
  opts: { forCount?: boolean } = {},
): BuiltQuery {
  const p = new Params();
  const where: string[] = [];

  // Only live listings are searchable, and this is not negotiable by input:
  // it is a literal, so no spec can widen the visible set to drafts.
  where.push(`l.status = 'live'`);

  if (spec.mode) where.push(`l.mode = ${p.add(spec.mode)}`);
  if (spec.roomType) where.push(`l.room_type = ${p.add(spec.roomType)}`);

  if (spec.propertyTypes?.length) {
    where.push(`l.property_type = ANY(${p.add(spec.propertyTypes)}::text[])`);
  }
  if (spec.minPriceCents !== undefined) where.push(`l.price_cents >= ${p.add(spec.minPriceCents)}`);
  if (spec.maxPriceCents !== undefined) where.push(`l.price_cents <= ${p.add(spec.maxPriceCents)}`);
  if (spec.minBeds !== undefined) where.push(`l.beds >= ${p.add(spec.minBeds)}`);
  if (spec.maxBeds !== undefined) where.push(`l.beds <= ${p.add(spec.maxBeds)}`);
  if (spec.minBaths !== undefined) where.push(`l.baths >= ${p.add(spec.minBaths)}`);
  if (spec.minSqft !== undefined) where.push(`l.sqft >= ${p.add(spec.minSqft)}`);
  if (spec.maxSqft !== undefined) where.push(`l.sqft <= ${p.add(spec.maxSqft)}`);

  if (spec.amenities?.length) {
    // Containment, not overlap: asking for parking AND laundry must not return
    // a listing with only parking. `@>` also uses listings_amenities_idx.
    where.push(`l.amenities @> ${p.add(spec.amenities)}::text[]`);
  }
  if (spec.neighbourhoodIds?.length) {
    where.push(`pr.neighbourhood_id = ANY(${p.add(spec.neighbourhoodIds)}::uuid[])`);
  }
  if (spec.city) where.push(`pr.city = ${p.add(spec.city)}`);
  if (spec.province) where.push(`pr.province = ${p.add(spec.province.toUpperCase())}`);

  // ── geography ─────────────────────────────────────────────────────────────
  if (spec.bbox) {
    where.push(...bboxPredicates(spec.bbox, p));
  } else if (spec.near) {
    // Bounding box first — that is the part an index can serve. The exact
    // distance then runs only over what survived it. Reversing this reads the
    // whole table on every map pan.
    const box = boundingBoxFor(
      { lat: spec.near.lat, lng: spec.near.lng },
      spec.near.radiusM,
    );
    where.push(...bboxPredicates(box, p));
    where.push(`${distanceExpr(p, spec.near.lat, spec.near.lng)} <= ${p.add(spec.near.radiusM)}`);
  }

  // ── full text ─────────────────────────────────────────────────────────────
  // The expression must match listings_fts_idx character for character, or
  // the index is not used and every search reads the table.
  let rankSelect = '';
  if (spec.q) {
    const q = p.add(spec.q);
    where.push(
      `to_tsvector('english', coalesce(l.search_text, '')) @@ websearch_to_tsquery('english', ${q})`,
    );
    rankSelect =
      `, ts_rank(to_tsvector('english', coalesce(l.search_text, '')), ` +
      `websearch_to_tsquery('english', ${q}))::float8 AS rank`;
  }

  const sort = SORTS[spec.sort];

  // ── keyset pagination ─────────────────────────────────────────────────────
  // Row comparison against (sort key, id). OFFSET would make page 50 read
  // fifty pages of rows to throw away forty-nine of them.
  // A count has no page to be on, so it takes no cursor: paging into a total
  // would return the number of results after the cursor, which is not a total.
  const cursor = opts.forCount ? null : decodeCursor(spec.cursor);
  if (cursor) {
    const cmp = sort.direction === 'DESC' ? '<' : '>';
    const key = cursorKeyExpr(spec.sort, p, cursor);
    where.push(`(${sort.expr}, l.id) ${cmp} (${key}, ${p.add(cursor.id)})`);
  }

  const predicates = where.join('\n       AND ');

  // Counting shares the predicates but nothing else. Building it from the same
  // `where` rather than a second list is the point: a count and its list that
  // are assembled separately drift apart, and then the header says 40 results
  // over a page that shows 38.
  if (opts.forCount) {
    return {
      text: `SELECT count(*)::text AS n
               FROM listings l
               JOIN properties pr ON pr.id = l.property_id
              WHERE ${predicates}`,
      params: p.values,
    };
  }

  const limitParam = p.add(spec.limit + 1);

  const text = `
    SELECT l.id, l.mode, l.status, l.price_cents, l.property_type, l.room_type,
           l.beds, l.baths, l.sqft, l.amenities, l.title, l.description,
           l.published_at, l.created_at,
           pr.address_line, pr.unit, pr.city, pr.province, pr.postal_code,
           pr.lat, pr.lng, pr.neighbourhood_id,
           ${sort.expr} AS sort_key${rankSelect}
      FROM listings l
      JOIN properties pr ON pr.id = l.property_id
     WHERE ${predicates}
     ORDER BY ${sort.expr} ${sort.direction} NULLS LAST, l.id ${sort.direction}
     LIMIT ${limitParam}`;

  return { text, params: p.values };
}

/**
 * Longitude range, split when the box crosses the antimeridian.
 *
 * Regina will never need this. It is here because a box with minLng > maxLng
 * is a legal box, and treating it as an inverted range silently returns
 * nothing rather than everything — a bug that would only ever appear once the
 * product left Saskatchewan, which is the worst time to find it.
 */
function bboxPredicates(box: BBox, p: Params): string[] {
  const out = [`pr.lat BETWEEN ${p.add(box.minLat)} AND ${p.add(box.maxLat)}`];
  if (box.minLng <= box.maxLng) {
    out.push(`pr.lng BETWEEN ${p.add(box.minLng)} AND ${p.add(box.maxLng)}`);
  } else {
    out.push(`(pr.lng >= ${p.add(box.minLng)} OR pr.lng <= ${p.add(box.maxLng)})`);
  }
  return out;
}

/**
 * Great-circle distance in metres, in SQL.
 *
 * PostGIS would give this as ST_DistanceSphere and an index to go with it.
 * Until it is enabled, the haversine is written out — it is exact, and it only
 * ever runs over rows the bounding box already selected.
 */
function distanceExpr(p: Params, lat: number, lng: number): string {
  const latP = p.add(lat);
  const lngP = p.add(lng);
  return (
    `(6371008.8 * 2 * asin(sqrt(` +
    `power(sin(radians(pr.lat - ${latP}) / 2), 2) + ` +
    `cos(radians(${latP})) * cos(radians(pr.lat)) * ` +
    `power(sin(radians(pr.lng - ${lngP}) / 2), 2)` +
    `)))`
  );
}

/**
 * The cursor's key, cast to whatever the sort column actually is.
 *
 * A timestamp cursor travels as epoch milliseconds because JSON has no date;
 * it has to become a timestamptz again or the comparison is against the wrong
 * type and Postgres refuses the row comparison outright.
 */
function cursorKeyExpr(sort: SortOrder, p: Params, cursor: Cursor): string {
  switch (sort) {
    case 'newest':
      return `to_timestamp(${p.add(cursor.k / 1000)})`;
    case 'price_asc':
    case 'price_desc':
      return `${p.add(Math.trunc(cursor.k))}::bigint`;
    case 'relevance':
      return `${p.add(cursor.k)}::float8`;
  }
}

/** Turns a row's sort key into the number the next cursor carries. */
export function cursorKeyOf(sort: SortOrder, row: { sort_key: unknown; rank?: unknown }): number {
  switch (sort) {
    case 'newest': {
      const v = row.sort_key;
      if (v instanceof Date) return v.getTime();
      // A live listing always has published_at, but a null would otherwise
      // become NaN and produce a cursor that matches nothing.
      return v === null || v === undefined ? 0 : new Date(String(v)).getTime();
    }
    case 'price_asc':
    case 'price_desc':
      return Number(row.sort_key);
    case 'relevance':
      return Number(row.rank ?? row.sort_key);
  }
}

/** Exposed so a test can assert every sort still names the index it needs. */
export const SORT_INDEXES: Readonly<Record<SortOrder, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SORTS).map(([k, v]) => [k, v.index]),
  ) as Record<SortOrder, string>,
);
