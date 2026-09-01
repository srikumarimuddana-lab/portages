/**
 * Search tests.
 *
 * The important ones are the injection tests. `buildSearch` assembles a SQL
 * string, which is the one place in this codebase where a mistake becomes a
 * data breach rather than a bug — so the assertions check not only that the
 * right query comes out, but that no input value ever appears in the SQL TEXT.
 *
 * The database-side behaviour these queries depend on — that the amenity
 * filter is containment, that keyset pages neither skip nor repeat, that each
 * sort still reaches an index — is asserted against real PostgreSQL in
 * test/sql/gazetteer.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSearch, cursorKeyOf, SORT_INDEXES } from '../src/modules/search/query.js';
import {
  decodeCursor, encodeCursor, filterSpecSchema, validateSpec, withDefaults,
  MAX_LIMIT, SORT_ORDERS, type FilterSpec, type SortOrder,
} from '../src/modules/search/spec.js';
import { specFromQuery } from '../src/http/routes/search.js';

const base = (over: Partial<FilterSpec> = {}): FilterSpec & { sort: SortOrder; limit: number } =>
  withDefaults({ ...over });

// ── injection ────────────────────────────────────────────────────────────────

test('injection: a hostile string reaches SQL only as a parameter', () => {
  const hostile = `'; DROP TABLE listings; --`;
  const { text, params } = buildSearch(base({ q: hostile, city: hostile }));

  assert.ok(!text.includes('DROP TABLE'), 'the payload must not appear in the SQL');
  assert.ok(!text.includes(hostile), 'no part of the input may be interpolated');
  assert.ok(params.includes(hostile), 'it must be present as a bound parameter');
});

test('injection: every parameter placeholder is numbered and sequential', () => {
  const { text, params } = buildSearch(base({
    mode: 'rent', minPriceCents: 100000, maxPriceCents: 200000,
    amenities: ['parking'], q: 'cathedral', city: 'Regina',
  }));
  const placeholders = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const highest = Math.max(...placeholders);
  assert.equal(highest, params.length, 'the highest $n must equal the parameter count');
  // Every index from 1..n is used, so no parameter is silently unbound.
  for (let i = 1; i <= params.length; i++) {
    assert.ok(placeholders.includes(i), `$${i} must appear in the query`);
  }
});

test('injection: the status literal cannot be widened by any input', () => {
  // Drafts are private. If a spec could reach `status`, search would leak them.
  const { text } = buildSearch(base({ mode: 'rent', q: "live' OR '1'='1" }));
  assert.equal((text.match(/l\.status = 'live'/g) ?? []).length, 1);
  assert.ok(!text.includes("OR '1'='1"));
});

test('injection: array filters bind one parameter regardless of length', () => {
  const one = buildSearch(base({ propertyTypes: ['condo'] }));
  const many = buildSearch(base({ propertyTypes: ['condo', 'detached', 'townhouse', 'apartment'] }));
  assert.equal(one.params.length, many.params.length,
    'an IN-list built per value would make these differ');
  assert.ok(many.text.includes('= ANY('));
});

// ── the spec schema ──────────────────────────────────────────────────────────

test('spec: an unknown filter field is rejected, not ignored', () => {
  // Ignoring it would let a future column become filterable by accident.
  const r = filterSpecSchema.parse({ mode: 'rent', ownerId: 'someone' });
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.errors.some((e) => /unknown field/.test(e)));
});

test('spec: a status filter is refused — search decides that, not the caller', () => {
  const r = filterSpecSchema.parse({ status: 'draft' });
  assert.equal(r.ok, false);
});

test('spec: an unlisted amenity or property type is refused', () => {
  assert.equal(filterSpecSchema.parse({ amenities: ['helipad'] }).ok, false);
  assert.equal(filterSpecSchema.parse({ propertyTypes: ['castle'] }).ok, false);
});

test('spec: the limit is bounded', () => {
  assert.equal(filterSpecSchema.parse({ limit: MAX_LIMIT + 1 }).ok, false);
  assert.equal(filterSpecSchema.parse({ limit: 0 }).ok, false);
  assert.equal(withDefaults({ limit: MAX_LIMIT }).limit, MAX_LIMIT);
});

test('spec: coordinates outside the world are refused', () => {
  assert.equal(filterSpecSchema.parse({ near: { lat: 91, lng: 0, radiusM: 100 } }).ok, false);
  assert.equal(filterSpecSchema.parse({ near: { lat: 0, lng: 181, radiusM: 100 } }).ok, false);
  assert.equal(filterSpecSchema.parse({ near: { lat: 50, lng: -104, radiusM: 100 } }).ok, true);
});

test('spec: an inverted range is caught rather than silently returning nothing', () => {
  // Valid SQL, zero results, no explanation — the worst kind of empty page.
  assert.deepEqual(
    validateSpec({ minPriceCents: 200000, maxPriceCents: 100000 }),
    ['minPriceCents must not be greater than maxPriceCents.'],
  );
  assert.equal(validateSpec({ minBeds: 3, maxBeds: 1 }).length, 1);
  assert.equal(validateSpec({ minSqft: 900, maxSqft: 500 }).length, 1);
});

test('spec: bbox and near together is a contradiction', () => {
  const problems = validateSpec({
    bbox: { minLat: 50, minLng: -105, maxLat: 51, maxLng: -104 },
    near: { lat: 50.4, lng: -104.6, radiusM: 1000 },
  });
  assert.equal(problems.length, 1);
});

test('spec: relevance sorting needs something to be relevant to', () => {
  assert.equal(validateSpec({ sort: 'relevance' }).length, 1);
  assert.equal(validateSpec({ sort: 'relevance', q: 'cathedral' }).length, 0);
});

test('spec: room type is refused on a sale search', () => {
  assert.equal(validateSpec({ mode: 'sale', roomType: 'private' }).length, 1);
  assert.equal(validateSpec({ mode: 'rent', roomType: 'private' }).length, 0);
});

test('spec: sort defaults to relevance with a query and newest without', () => {
  assert.equal(withDefaults({}).sort, 'newest');
  assert.equal(withDefaults({ q: 'cathedral' }).sort, 'relevance');
  assert.equal(withDefaults({ q: 'cathedral', sort: 'price_asc' }).sort, 'price_asc');
});

// ── cursors ──────────────────────────────────────────────────────────────────

const ID = '11111111-1111-4111-8111-111111111111';

test('cursor: round-trips', () => {
  assert.deepEqual(decodeCursor(encodeCursor({ k: 150000, id: ID })), { k: 150000, id: ID });
});

test('cursor: anything malformed decodes to null rather than throwing', () => {
  for (const bad of [
    undefined, '', 'not-base64!!', Buffer.from('{}').toString('base64url'),
    Buffer.from('{"k":"nope","id":"' + ID + '"}').toString('base64url'),
    Buffer.from('{"k":1,"id":"not-a-uuid"}').toString('base64url'),
    Buffer.from('{"k":null,"id":"' + ID + '"}').toString('base64url'),
  ]) {
    assert.equal(decodeCursor(bad as string | undefined), null, `cursor ${String(bad)}`);
  }
});

test('cursor: an oversized payload is refused before it is parsed', () => {
  const huge = Buffer.from(JSON.stringify({ k: 1, id: ID, pad: 'x'.repeat(5000) }))
    .toString('base64url');
  assert.equal(decodeCursor(huge), null);
});

test('cursor: a forged cursor cannot reach a non-live listing', () => {
  // Cursors are deliberately unsigned. This is the reason that is safe: the
  // cursor only ever narrows within the live set, never widens it.
  const { text } = buildSearch(base({ cursor: encodeCursor({ k: 0, id: ID }) }));
  assert.ok(text.includes(`l.status = 'live'`));
});

test('cursor: the key expression matches the column type of each sort', () => {
  const forNewest = buildSearch(base({ sort: 'newest', cursor: encodeCursor({ k: 1_700_000_000_000, id: ID }) }));
  assert.ok(forNewest.text.includes('to_timestamp('), 'a timestamp sort needs a timestamp');

  const forPrice = buildSearch(base({ sort: 'price_asc', cursor: encodeCursor({ k: 150000, id: ID }) }));
  assert.ok(forPrice.text.includes('::bigint'), 'a price sort compares against bigint');

  const forRank = buildSearch(base({ sort: 'relevance', q: 'x', cursor: encodeCursor({ k: 0.5, id: ID }) }));
  assert.ok(forRank.text.includes('::float8'));
});

test('cursor: direction follows the sort', () => {
  const asc = buildSearch(base({ sort: 'price_asc', cursor: encodeCursor({ k: 1, id: ID }) }));
  const desc = buildSearch(base({ sort: 'price_desc', cursor: encodeCursor({ k: 1, id: ID }) }));
  assert.ok(asc.text.includes(') > ('), 'ascending pages forward with >');
  assert.ok(desc.text.includes(') < ('), 'descending pages forward with <');
});

test('cursor: a date key survives the round trip through a Date row', () => {
  const when = new Date('2026-03-01T12:00:00Z');
  assert.equal(cursorKeyOf('newest', { sort_key: when }), when.getTime());
  assert.equal(cursorKeyOf('newest', { sort_key: null }), 0, 'a null must not become NaN');
  assert.equal(cursorKeyOf('price_asc', { sort_key: '150000' }), 150000);
  assert.equal(cursorKeyOf('relevance', { sort_key: 0.5, rank: 0.75 }), 0.75);
});

// ── query shape ──────────────────────────────────────────────────────────────

test('query: one extra row is requested, to detect the next page without a COUNT', () => {
  const { params } = buildSearch(base({ limit: 24 }));
  assert.equal(params[params.length - 1], 25);
});

test('query: every sort names an index that exists in a migration', () => {
  for (const sort of SORT_ORDERS) {
    assert.ok(SORT_INDEXES[sort], `${sort} must name an index`);
  }
  // Both price directions share one index: a btree read backward serves the
  // descending order, verified in test/sql/gazetteer.sql.
  assert.equal(SORT_INDEXES.price_asc, SORT_INDEXES.price_desc);
});

test('query: the FTS expression matches listings_fts_idx exactly', () => {
  // Spelled differently, the index is silently unused and every search reads
  // the table. The index is on to_tsvector('english', coalesce(search_text,'')).
  const { text } = buildSearch(base({ q: 'cathedral' }));
  assert.ok(text.includes(`to_tsvector('english', coalesce(l.search_text, ''))`));
  assert.ok(text.includes('websearch_to_tsquery'));
});

test('query: amenities use containment, so the filter means AND', () => {
  const { text } = buildSearch(base({ amenities: ['parking', 'in_suite_laundry'] }));
  assert.ok(text.includes('l.amenities @>'), 'overlap (&&) would mean OR');
});

test('query: a radius search adds a bbox prefilter before the exact distance', () => {
  const { text } = buildSearch(base({ near: { lat: 50.4452, lng: -104.6178, radiusM: 1000 } }));
  assert.ok(text.includes('pr.lat BETWEEN'), 'the indexable prefilter must be present');
  assert.ok(text.includes('asin(sqrt('), 'and the exact haversine after it');
});

test('query: a box spanning the antimeridian is split, not inverted', () => {
  const { text } = buildSearch(base({
    bbox: { minLat: -10, maxLat: 10, minLng: 170, maxLng: -170 },
  }));
  assert.ok(text.includes('OR'), 'the longitude range must be split into two');
  assert.ok(!text.includes('pr.lng BETWEEN'), 'a BETWEEN here would match nothing');
});

test('query: an ordinary box uses BETWEEN', () => {
  const { text } = buildSearch(base({
    bbox: { minLat: 50.4, maxLat: 50.5, minLng: -104.7, maxLng: -104.5 },
  }));
  assert.ok(text.includes('pr.lng BETWEEN'));
});

test('query: count shares the predicates but takes no cursor or limit', () => {
  const spec = base({ mode: 'rent', minPriceCents: 100000, cursor: encodeCursor({ k: 1, id: ID }) });
  const page = buildSearch(spec);
  const count = buildSearch(spec, { forCount: true });

  assert.ok(count.text.includes('count(*)'));
  assert.ok(!count.text.includes('LIMIT'), 'a count has no page');
  assert.ok(!count.text.includes(') > ('), 'a count must ignore the cursor');
  // Both must carry the same filters, or the header disagrees with the list.
  for (const frag of [`l.status = 'live'`, 'l.mode =', 'l.price_cents >=']) {
    assert.ok(page.text.includes(frag) && count.text.includes(frag), frag);
  }
});

test('query: an empty spec is still constrained to live listings', () => {
  const { text, params } = buildSearch(base({}));
  assert.ok(text.includes(`l.status = 'live'`));
  assert.equal(params.length, 1, 'only the limit is bound');
});

// ── query-string translation ─────────────────────────────────────────────────

test('query string: reads the fields it knows', () => {
  const spec = specFromQuery(new URLSearchParams(
    'mode=rent&minPriceCents=100000&amenities=parking,in_suite_laundry&limit=10',
  ));
  assert.equal(spec['mode'], 'rent');
  assert.equal(spec['minPriceCents'], 100000);
  assert.deepEqual(spec['amenities'], ['parking', 'in_suite_laundry']);
});

test('query string: an unknown parameter is not passed through', () => {
  // It must not reach the schema, which would reject the whole request for an
  // unknown key that the user never typed.
  const spec = specFromQuery(new URLSearchParams('mode=rent&utm_source=twitter'));
  assert.deepEqual(Object.keys(spec), ['mode']);
});

test('query string: a non-numeric number is reported, not dropped', () => {
  // Dropping it would return unfiltered results for a filter the user set.
  const spec = specFromQuery(new URLSearchParams('minPriceCents=cheap'));
  assert.equal(spec['minPriceCents'], 'cheap');
  assert.equal(filterSpecSchema.parse(spec).ok, false);
});

test('query string: a partial bbox is ignored rather than half-applied', () => {
  assert.equal(specFromQuery(new URLSearchParams('minLat=50&maxLat=51'))['bbox'], undefined);
  assert.ok(specFromQuery(new URLSearchParams(
    'minLat=50&minLng=-105&maxLat=51&maxLng=-104',
  ))['bbox']);
});

test('query string: the radius is capped before it reaches the schema', () => {
  const spec = specFromQuery(new URLSearchParams('lat=50&lng=-104&radiusM=999999999'));
  assert.equal((spec['near'] as { radiusM: number }).radiusM, 50_000);
});

test('query string: repeated and comma-joined list values both work', () => {
  const repeated = specFromQuery(new URLSearchParams('amenities=parking&amenities=yard'));
  const joined = specFromQuery(new URLSearchParams('amenities=parking,yard'));
  assert.deepEqual(repeated['amenities'], joined['amenities']);
});

// ── the cover photo ─────────────────────────────────────────────────────────

test('the cover photo is chosen only from photos that exist', async () => {
  // DISTINCT ON takes ONE row per listing. Without a status filter, an
  // abandoned upload sitting at position 0 becomes the cover image on every
  // search result for a listing whose real photos are right behind it — a
  // broken image on the page that carries the whole product.
  //
  // That the filter changes the answer is proved against real PostgreSQL in
  // test/sql/uploads.sql; this proves the service sends the filtered form.
  const { SearchService } = await import('../src/modules/search/service.js');

  const sent: string[] = [];
  const db = {
    async query(text: string) {
      sent.push(text);
      return text.includes('DISTINCT ON')
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: 'l-1', mode: 'rent', status: 'live', price_cents: '150000',
                     property_type: 'apartment', room_type: null, beds: 2, baths: null,
                     sqft: null, amenities: [], title: 't', description: null,
                     published_at: new Date(), created_at: new Date(),
                     address_line: 'x', unit: null, city: 'Regina', province: 'SK',
                     postal_code: null, lat: null, lng: null, neighbourhood_id: null }],
            rowCount: 1 };
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> { return fn(db); },
  } as never;

  await new SearchService(db).search({ sort: 'newest', limit: 5 });

  const cover = sent.find((t) => t.includes('DISTINCT ON'));
  assert.ok(cover, 'the cards should fetch their cover photos');
  assert.match(cover!, /status = 'stored'/);
});

// ── the search page's URL ───────────────────────────────────────────────────
//
// The page URL is a public contract: it is what gets bookmarked, shared and
// indexed. These are about the translation between it and the spec the search
// module takes — the one place the two vocabularies meet.

test('dollars in the URL become cents in the spec', async () => {
  // People do not type 150000 when they mean $1,500, and a URL somebody can
  // read is the point of having one. The database only knows cents.
  const { filterValuesFrom, specFrom } = await import('../src/web/search-query.js');
  const spec = specFrom(
    filterValuesFrom(new URLSearchParams('minPrice=1500&maxPrice=2200.50')), 24,
  );
  assert.equal(spec['minPriceCents'], 150_000);
  assert.equal(spec['maxPriceCents'], 220_050);
  assert.ok(!('minPrice' in spec), 'the page vocabulary must not leak into the spec');
});

test('a filter nobody set is absent from the spec, not present as undefined', async () => {
  // `minBeds: undefined` is not the same as no minBeds to a validator that
  // checks `in`, and it is how a filter nobody asked for reaches a WHERE.
  const { filterValuesFrom, specFrom } = await import('../src/web/search-query.js');
  const spec = specFrom(filterValuesFrom(new URLSearchParams('q=cathedral')), 24);
  for (const k of ['minBeds', 'minBaths', 'minSqft', 'minPriceCents', 'maxPriceCents', 'mode']) {
    assert.ok(!(k in spec), `${k} should be absent, got ${String(spec[k])}`);
  }
  assert.deepEqual(Object.keys(spec).sort(), ['limit', 'q', 'sort']);
});

test('an amenity outside the allowlist is dropped, not passed on', async () => {
  const { filterValuesFrom } = await import('../src/web/search-query.js');
  const v = filterValuesFrom(new URLSearchParams('amenities=parking&amenities=helipad'));
  assert.deepEqual(v.amenities, ['parking']);
});

test('a nonsense number in the URL is ignored rather than failing the page', async () => {
  // Someone arriving with a hand-edited or stale URL should see listings. The
  // JSON API is the surface that reports a bad filter; this one shows homes.
  const { filterValuesFrom, specFrom } = await import('../src/web/search-query.js');
  const spec = specFrom(filterValuesFrom(new URLSearchParams('minBeds=lots&minPrice=-5')), 24);
  assert.ok(!('minBeds' in spec));
  assert.ok(!('minPriceCents' in spec));
});

test('relevance is refused when there is nothing to be relevant to', async () => {
  const { filterValuesFrom, specFrom } = await import('../src/web/search-query.js');

  const noQuery = specFrom(filterValuesFrom(new URLSearchParams('sort=relevance')), 24);
  assert.equal(noQuery['sort'], 'newest');

  const withQuery = specFrom(filterValuesFrom(new URLSearchParams('sort=relevance&q=cathedral')), 24);
  assert.equal(withQuery['sort'], 'relevance');
});

test('an unknown sort falls back rather than reaching the query builder', async () => {
  const { filterValuesFrom, specFrom } = await import('../src/web/search-query.js');
  const spec = specFrom(filterValuesFrom(new URLSearchParams('sort=cheapest')), 24);
  assert.equal(spec['sort'], 'newest');
});

test('every spec the page builds is one the search module accepts', async () => {
  // The two vocabularies meeting is exactly where a typo produces a filter
  // that is silently ignored. Running the real parser over a filled-in URL is
  // what catches a key the schema does not know.
  const { filterValuesFrom, specFrom } = await import('../src/web/search-query.js');
  const { SearchService } = await import('../src/modules/search/service.js');
  const svc = new SearchService({} as never);

  const url = new URLSearchParams(
    'q=cathedral&mode=rent&minPrice=1000&maxPrice=2000&minBeds=2&minBaths=1'
    + '&minSqft=600&propertyTypes=apartment&amenities=parking&amenities=balcony&sort=price_asc',
  );
  const parsed = svc.parse(specFrom(filterValuesFrom(url), 24));

  assert.equal(parsed.q, 'cathedral', 'the words typed are the point of the search');
  assert.equal(parsed.mode, 'rent');
  assert.equal(parsed.minPriceCents, 100_000);
  assert.equal(parsed.maxPriceCents, 200_000);
  assert.equal(parsed.minBeds, 2);
  assert.deepEqual(parsed.amenities, ['parking', 'balcony']);
  assert.equal(parsed.sort, 'price_asc');
});

test('removing one chip keeps every other filter', async () => {
  // The commonest confusion on a filtered search is an empty page caused by a
  // filter set three refinements ago. The chips are the way back, so removing
  // one must not quietly take others with it.
  const { filterValuesFrom, chipsFor } = await import('../src/web/search-query.js');
  const params = new URLSearchParams(
    'q=cathedral&mode=rent&minBeds=2&amenities=parking&amenities=balcony',
  );
  const chips = chipsFor(params, filterValuesFrom(params));

  const parking = chips.find((c) => c.label === 'parking');
  assert.ok(parking, 'an applied amenity should have a chip');

  const after = new URL(parking!.without, 'https://portage.ca').searchParams;
  assert.deepEqual(after.getAll('amenities'), ['balcony'], 'only that one amenity goes');
  assert.equal(after.get('mode'), 'rent');
  assert.equal(after.get('minBeds'), '2');
  assert.equal(after.get('q'), 'cathedral');
});

test('removing the last filter leaves a clean URL, not a dangling question mark', async () => {
  const { filterValuesFrom, chipsFor } = await import('../src/web/search-query.js');
  const params = new URLSearchParams('mode=rent');
  const chips = chipsFor(params, filterValuesFrom(params));
  assert.equal(chips[0]!.without, '/search');
});

test('the active count ignores the text query and the sort', async () => {
  // It labels a collapsed panel. Counting the search box would say "1 filter"
  // to someone who has set none.
  const { filterValuesFrom, activeCount } = await import('../src/web/search-query.js');
  assert.equal(activeCount(filterValuesFrom(new URLSearchParams('q=cathedral&sort=newest'))), 0);
  assert.equal(activeCount(filterValuesFrom(new URLSearchParams('mode=rent&minBeds=2'))), 2);
  assert.equal(
    activeCount(filterValuesFrom(new URLSearchParams('amenities=parking&amenities=balcony'))),
    1, 'a group of amenities is one filter, not one per amenity',
  );
});

test('the sort form carries every filter except the sort itself', async () => {
  // A GET form submits only its own fields. Without these the sort control is
  // a filter reset with a misleading label.
  const { hiddenFields } = await import('../src/web/search-query.js');
  const params = new URLSearchParams(
    'q=cathedral&mode=rent&minPrice=1000&minBeds=2&amenities=parking&amenities=balcony&sort=price_asc',
  );
  const fields = hiddenFields(params);
  const asParams = new URLSearchParams(fields.map(([k, v]) => [k, v]));

  assert.equal(asParams.get('q'), 'cathedral');
  assert.equal(asParams.get('mode'), 'rent');
  assert.equal(asParams.get('minPrice'), '1000');
  assert.equal(asParams.get('minBeds'), '2');
  assert.deepEqual(
    fields.filter(([k]) => k === 'amenities').map(([, v]) => v),
    ['parking', 'balcony'],
    'a multi-valued filter must survive as several fields, not one',
  );
  assert.ok(
    !fields.some(([k]) => k === 'sort'),
    'the sort must NOT be carried: the select is what sets it, and a hidden '
    + 'field of the same name would win or duplicate it',
  );
});

test('a saved search round-trips: URL to spec to URL is the same search', async () => {
  // The stored spec is in the API's vocabulary and the link on the saved
  // searches page has to be in the page's. The two directions are written
  // separately, so nothing but this would notice them disagreeing — and the
  // symptom would be a saved search whose link shows an unfiltered page while
  // claiming to be the one that was saved.
  const { filterValuesFrom, specFrom, specToQuery } = await import('../src/web/search-query.js');

  const original = 'q=cathedral&mode=rent&minPrice=1000&maxPrice=2000&minBeds=2'
    + '&minBaths=1&minSqft=600&propertyTypes=apartment&amenities=parking'
    + '&amenities=balcony&sort=price_asc';

  const spec = specFrom(filterValuesFrom(new URLSearchParams(original)), 24);
  const back = new URLSearchParams(specToQuery(spec));
  const again = specFrom(filterValuesFrom(back), 24);

  assert.deepEqual(again, spec, 'the second trip must produce the identical spec');
  assert.equal(back.get('minPrice'), '1000', 'and dollars must come back as dollars');
  assert.deepEqual(back.getAll('amenities'), ['parking', 'balcony']);
});

test('the reverse trip carries no limit or cursor into a URL', async () => {
  // `limit` is a page-size decision the route makes, not a filter the person
  // chose; putting it in the URL invites someone to set it to 10000.
  const { specToQuery } = await import('../src/web/search-query.js');
  const q = new URLSearchParams(specToQuery({ minBeds: 2, limit: 24, cursor: 'abc' }));
  assert.equal(q.get('minBeds'), '2');
  assert.equal(q.get('limit'), null);
  assert.equal(q.get('cursor'), null);
});
