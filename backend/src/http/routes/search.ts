/**
 * Search and gazetteer routes.
 *
 * All public and all read-only. Search is the demand side of a marketplace
 * with no listings yet, so these are the endpoints that have to work before
 * anything else is worth visiting.
 */
import { guard, type GuardConfig } from '../guard.js';
import { json, errorResponse, type ResponseContext } from '../respond.js';
import { badRequest } from '../../lib/errors.js';
import { MAX_RADIUS_M } from '../../modules/search/spec.js';
import { MIN_QUERY_LENGTH } from '../../modules/geo/gazetteer.js';
import type { SearchService } from '../../modules/search/service.js';
import type { Gazetteer } from '../../modules/geo/gazetteer.js';

export interface SearchRouteDeps {
  cfg: GuardConfig;
  search: SearchService;
  gazetteer: Gazetteer;
  hsts: boolean;
}

function ctxOf(requestId: string, origin: string | undefined, deps: SearchRouteDeps): ResponseContext {
  return { requestId, origin, allowedOrigins: deps.cfg.allowedOrigins, hsts: deps.hsts };
}

/**
 * GET /api/search/listings
 *
 * Filters arrive as query parameters and are assembled into a FilterSpec,
 * which the service then validates. Nothing here decides what is valid — this
 * function only translates one wire format into the shape the single
 * validator understands, so the AI path and this path cannot diverge.
 */
export async function searchListings(req: Request, deps: SearchRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: false, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;

    const spec = specFromQuery(new URL(req.url).searchParams);
    const page = await deps.search.search(spec);
    return json(page, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** GET /api/search/count — how many listings match, without a page of them. */
export async function countListings(req: Request, deps: SearchRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: false, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;

    const spec = deps.search.parse(specFromQuery(new URL(req.url).searchParams));
    return json({ count: await deps.search.count(spec) }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** GET /api/geo/autocomplete?q= — address suggestions from the gazetteer. */
export async function autocomplete(req: Request, deps: SearchRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: false, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;

    const params = new URL(req.url).searchParams;
    const q = (params.get('q') ?? '').slice(0, 200);
    // Short inputs return empty rather than erroring: a keystroke-by-keystroke
    // client would otherwise get an error for the first two characters of
    // every single search.
    if (q.trim().length < MIN_QUERY_LENGTH) {
      return json({ suggestions: [] }, ctxOf(ctx.requestId, ctx.origin, deps));
    }

    const suggestions = await deps.gazetteer.suggest({
      query: q,
      limit: intParam(params.get('limit'), 8),
      city: params.get('city') ?? undefined,
      province: params.get('province')?.toUpperCase() ?? undefined,
    });
    return json({ suggestions }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** GET /api/geo/neighbourhoods — boundaries for map overlays. */
export async function neighbourhoods(req: Request, deps: SearchRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: false, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;

    const params = new URL(req.url).searchParams;
    const hoods = await deps.gazetteer.neighbourhoods(
      params.get('city') ?? 'Regina',
      (params.get('province') ?? 'SK').toUpperCase(),
    );
    // Boundaries are heavy and change roughly never, so they are worth
    // caching hard at the edge; without this every map load re-downloads
    // every polygon in the city.
    const res = json({ neighbourhoods: hoods }, ctxOf(ctx.requestId, ctx.origin, deps));
    res.headers.set('cache-control', 'public, max-age=3600, stale-while-revalidate=86400');
    return res;
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** GET /api/geo/health — how much gazetteer data is loaded, and how fresh. */
export async function geoHealth(req: Request, deps: SearchRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: false, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;
    return json(await deps.gazetteer.health(), ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

// ── query-string translation ────────────────────────────────────────────────

/**
 * Builds a FilterSpec from query parameters.
 *
 * Deliberately dumb: it reads the names it knows and ignores everything else,
 * producing a plain object. Every judgement about whether a value is
 * acceptable belongs to filterSpecSchema, which runs next — including the
 * rejection of unknown keys, which is why this function must not pass through
 * anything it was not asked for.
 */
export function specFromQuery(params: URLSearchParams): Record<string, unknown> {
  const spec: Record<string, unknown> = {};

  const str = (key: string, into = key) => {
    const raw = params.get(key);
    if (raw !== null && raw !== '') spec[into] = raw;
  };
  const num = (key: string, into = key) => {
    const raw = params.get(key);
    if (raw === null || raw === '') return;
    const n = Number(raw);
    // A non-numeric value is passed through as the raw string so the schema
    // reports "must be a number" rather than this silently dropping it and
    // returning results for a filter the user thinks they applied.
    spec[into] = Number.isFinite(n) ? n : raw;
  };
  const list = (key: string, into = key) => {
    const all = params.getAll(key).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
    if (all.length > 0) spec[into] = all;
  };

  str('mode'); str('roomType'); str('city'); str('province');
  str('q'); str('sort'); str('cursor');
  num('minPriceCents'); num('maxPriceCents');
  num('minBeds'); num('maxBeds'); num('minBaths');
  num('minSqft'); num('maxSqft'); num('limit');
  list('propertyTypes'); list('amenities'); list('neighbourhoodIds');

  const bbox = ['minLat', 'minLng', 'maxLat', 'maxLng'].map((k) => params.get(k));
  if (bbox.every((v) => v !== null && v !== '')) {
    spec['bbox'] = {
      minLat: Number(bbox[0]), minLng: Number(bbox[1]),
      maxLat: Number(bbox[2]), maxLng: Number(bbox[3]),
    };
  }

  const lat = params.get('lat'), lng = params.get('lng'), radius = params.get('radiusM');
  if (lat !== null && lng !== null && radius !== null) {
    spec['near'] = {
      lat: Number(lat), lng: Number(lng),
      radiusM: Math.min(Number(radius) || 0, MAX_RADIUS_M),
    };
  }
  return spec;
}

function intParam(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export { badRequest };
