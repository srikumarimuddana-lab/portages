/**
 * The search page's URL, and what it means.
 *
 * THE URL IS THE USER'S; THE SPEC IS THE API'S. The page uses names a person
 * can read in their own address bar — `?minPrice=1500&minBeds=2` — and the
 * search module takes cents and its own vocabulary. This file is the one place
 * that translates, so there is exactly one definition of what a page URL means
 * and the page cannot drift from what the server actually filtered on.
 *
 * Nothing here validates. Every value is handed to `SearchService.parse`,
 * which runs the same schema the JSON API runs — so a hostile or nonsensical
 * parameter is refused by the code that already refuses it, rather than by a
 * second set of rules written for the browser.
 */
import { AMENITIES, PROPERTY_TYPES } from '../modules/listings/policy.js';
import { SORT_ORDERS } from '../modules/search/spec.js';
import type { FilterValues } from './pages-parts.js';

/** Dollars in a URL are a person's unit. Cents are the database's. */
const CENTS = 100;

function num(params: URLSearchParams, key: string): number | undefined {
  const raw = (params.get(key) ?? '').trim();
  if (!raw) return undefined;
  const n = Number(raw);
  // Not passed through as a string: on this surface a nonsense value came
  // from someone editing the URL, and the useful response is to ignore it and
  // show results rather than to refuse the whole page.
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Multi-valued parameters, filtered to the allowlist.
 *
 * `?amenities=parking&amenities=helipad` keeps parking and drops the other.
 * The schema would reject the whole search; dropping is better here, because
 * the person typing in the address bar is not who this page is for and the
 * ones who arrive with a stale bookmark should still see listings.
 */
function allowed(params: URLSearchParams, key: string, from: readonly string[]): string[] {
  const set = new Set<string>(from);
  return params.getAll(key)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => set.has(v));
}

/** What the form should show, read back from the URL that produced the page. */
export function filterValuesFrom(params: URLSearchParams): FilterValues {
  const mode = params.get('mode');
  const sort = params.get('sort');
  return {
    q: (params.get('q') ?? '').slice(0, 200),
    ...(mode === 'rent' || mode === 'sale' ? { mode } : {}),
    propertyTypes: allowed(params, 'propertyTypes', PROPERTY_TYPES),
    amenities: allowed(params, 'amenities', AMENITIES),
    minPrice: num(params, 'minPrice'),
    maxPrice: num(params, 'maxPrice'),
    minBeds: num(params, 'minBeds'),
    minBaths: num(params, 'minBaths'),
    minSqft: num(params, 'minSqft'),
    ...(SORT_ORDERS.includes(sort as never) ? { sort: sort! } : {}),
  };
}

/**
 * The same values as a spec the search module accepts.
 *
 * Built by omission rather than by assignment: a key present with `undefined`
 * is not the same as an absent key to a validator that checks `in`, and
 * "minBeds: undefined" reaching the query builder is how a filter nobody set
 * ends up in a WHERE clause.
 */
export function specFrom(values: FilterValues, limit: number): Record<string, unknown> {
  const spec: Record<string, unknown> = { limit };

  if (values.q) spec['q'] = values.q;
  if (values.mode) spec['mode'] = values.mode;
  if (values.propertyTypes?.length) spec['propertyTypes'] = [...values.propertyTypes];
  if (values.amenities?.length) spec['amenities'] = [...values.amenities];
  if (values.minPrice !== undefined) spec['minPriceCents'] = Math.round(values.minPrice * CENTS);
  if (values.maxPrice !== undefined) spec['maxPriceCents'] = Math.round(values.maxPrice * CENTS);
  if (values.minBeds !== undefined) spec['minBeds'] = Math.trunc(values.minBeds);
  if (values.minBaths !== undefined) spec['minBaths'] = values.minBaths;
  if (values.minSqft !== undefined) spec['minSqft'] = Math.trunc(values.minSqft);

  // Relevance needs something to be relevant TO. Asking for it without a
  // query is not an error, it is a request that cannot be honoured, so it
  // falls back to the ordering people expect from a listings site.
  spec['sort'] = values.sort && (values.sort !== 'relevance' || values.q)
    ? values.sort
    : (values.q ? 'relevance' : 'newest');

  return spec;
}

/** How many filters are set, not counting the text query or the sort. */
export function activeCount(values: FilterValues): number {
  return [
    values.mode,
    values.propertyTypes?.length ? '1' : undefined,
    values.amenities?.length ? '1' : undefined,
    values.minPrice, values.maxPrice,
    values.minBeds, values.minBaths, values.minSqft,
  ].filter((v) => v !== undefined && v !== '').length;
}

export interface Chip {
  label: string;
  /** The same search with this filter removed. */
  without: string;
}

/**
 * One removable chip per applied filter.
 *
 * Each `without` is built from the ACTUAL parameters, not reconstructed from
 * the parsed values, so removing one filter cannot quietly normalise or drop
 * another that this file does not know about.
 */
export function chipsFor(params: URLSearchParams, values: FilterValues): Chip[] {
  const chips: Chip[] = [];

  const drop = (key: string, value?: string): string => {
    const next = new URLSearchParams(params);
    if (value === undefined) {
      next.delete(key);
    } else {
      // One value out of several: delete and re-add the rest, because
      // URLSearchParams has no "remove this one occurrence".
      const keep = next.getAll(key).flatMap((v) => v.split(',')).filter((v) => v !== value);
      next.delete(key);
      for (const k of keep) next.append(key, k);
    }
    const qs = next.toString();
    return qs ? `/search?${qs}` : '/search';
  };

  if (values.mode) {
    chips.push({ label: values.mode === 'rent' ? 'To rent' : 'To buy', without: drop('mode') });
  }
  if (values.minPrice !== undefined) {
    chips.push({ label: `From $${values.minPrice.toLocaleString('en-CA')}`, without: drop('minPrice') });
  }
  if (values.maxPrice !== undefined) {
    chips.push({ label: `Up to $${values.maxPrice.toLocaleString('en-CA')}`, without: drop('maxPrice') });
  }
  if (values.minBeds !== undefined) {
    chips.push({ label: `${values.minBeds}+ bed`, without: drop('minBeds') });
  }
  if (values.minBaths !== undefined) {
    chips.push({ label: `${values.minBaths}+ bath`, without: drop('minBaths') });
  }
  if (values.minSqft !== undefined) {
    chips.push({ label: `${values.minSqft}+ sq ft`, without: drop('minSqft') });
  }
  for (const t of values.propertyTypes ?? []) {
    chips.push({ label: t.replace(/_/g, ' '), without: drop('propertyTypes', t) });
  }
  for (const a of values.amenities ?? []) {
    chips.push({ label: a.replace(/_/g, ' '), without: drop('amenities', a) });
  }
  return chips;
}

/** The same search with every filter dropped and the text query kept. */
export function clearHref(values: FilterValues): string {
  return values.q ? `/search?q=${encodeURIComponent(values.q)}` : '/search';
}

/**
 * Every current parameter except the sort, as hidden fields.
 *
 * The sort control is its own GET form, and a form submits only its own
 * fields — so without these, changing the sort would clear every filter the
 * person had just set. Rebuilt from the raw parameters rather than from the
 * parsed values so a parameter this file does not model still survives.
 */
export function hiddenFields(params: URLSearchParams): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const key of ['q', 'mode', 'minPrice', 'maxPrice', 'minBeds', 'minBaths', 'minSqft']) {
    const v = params.get(key);
    if (v) out.push([key, v]);
  }
  for (const key of ['propertyTypes', 'amenities']) {
    for (const v of params.getAll(key)) if (v) out.push([key, v]);
  }
  return out;
}

/**
 * The reverse trip: a stored spec back into a page URL.
 *
 * A saved search is stored in the API's vocabulary — cents, `minPriceCents` —
 * because that is what the search module validated and will re-run. The link
 * on the saved-searches page has to be a URL the search PAGE understands, or
 * following it would show an unfiltered search while claiming to be the one
 * that was saved.
 *
 * Round-tripping is the property that matters: `specToQuery(specFrom(v))`
 * must produce the same search. A test asserts it, because the two directions
 * are written separately and nothing else would notice them disagreeing.
 */
export function specToQuery(spec: Readonly<Record<string, unknown>> | object): string {
  const src = spec as Record<string, unknown>;
  const out = new URLSearchParams();
  const str = (key: string, into = key) => {
    const v = src[key];
    if (typeof v === 'string' && v) out.set(into, v);
  };
  const dollars = (key: string, into: string) => {
    const v = src[key];
    if (typeof v === 'number') out.set(into, String(v / CENTS));
  };
  const int = (key: string) => {
    const v = src[key];
    if (typeof v === 'number') out.set(key, String(v));
  };
  const list = (key: string) => {
    const v = src[key];
    if (Array.isArray(v)) for (const item of v) if (typeof item === 'string') out.append(key, item);
  };

  str('q');
  str('mode');
  dollars('minPriceCents', 'minPrice');
  dollars('maxPriceCents', 'maxPrice');
  int('minBeds'); int('minBaths'); int('minSqft');
  list('propertyTypes'); list('amenities');
  str('sort');

  return out.toString();
}
