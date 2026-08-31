/**
 * AI routes.
 *
 * Two endpoints, and both are wrappers around something that already worked
 * without them. That is the shape the whole AI layer is built to:
 *
 *   POST /api/search/ai            a sentence instead of filter checkboxes
 *   POST /api/listings/:id/describe  a first draft instead of a blank box
 *
 * Neither is load-bearing. If the model is off, refuses, times out, or
 * produces something that fails validation, the caller gets the non-AI
 * outcome — a plain text search, or the empty description field the owner
 * already had. Nothing here can return a 500 because a provider had a bad day.
 *
 * `requireFlag` does the kill-switch work, so a switched-off feature is
 * refused with 503 before the body is even read. Both flags fail CLOSED: if
 * the flag store is unreadable, AI stays off. See modules/flags/registry.ts.
 */
import * as v from '../../lib/validate.js';
import { guard, type GuardConfig } from '../guard.js';
import { json, errorResponse, type ResponseContext } from '../respond.js';
import { badRequest, notFound, serviceUnavailable } from '../../lib/errors.js';
import { ProviderError } from '../../modules/ai/provider.js';
import type { ChatSearchService } from '../../modules/ai/chat-search.js';
import type { ListingBuilderService } from '../../modules/ai/listing-builder.js';
import type { MeteredProvider } from '../../modules/ai/ledger.js';
import type { SearchService } from '../../modules/search/service.js';
import type { Gazetteer } from '../../modules/geo/gazetteer.js';
import type { ListingService } from '../../modules/listings/service.js';
import type { Limiter } from '../../lib/ratelimit-db.js';

export interface AiRouteDeps {
  cfg: GuardConfig;
  chatSearch: ChatSearchService;
  listingBuilder: ListingBuilderService;
  search: SearchService;
  gazetteer: Gazetteer;
  listings: ListingService;
  /** Wraps the provider so every call is attributed and recorded. */
  metered: MeteredProvider;
  /**
   * Per-account daily cap on model calls.
   *
   * The kill switch is global and the Gateway budget is account-wide; neither
   * stops ONE user running the bill up. Requests are capped rather than
   * tokens because `maxTokens` is already fixed per task, so a request cap IS
   * a spend cap — and it reuses the durable limiter rather than inventing a
   * second accounting mechanism.
   */
  aiLimiter: Limiter;
  hsts: boolean;
}

const askBody = v.object({
  q: v.string({ min: 3, max: 400 }),
});

function ctxOf(requestId: string, origin: string | undefined, deps: AiRouteDeps): ResponseContext {
  return { requestId, origin, allowedOrigins: deps.cfg.allowedOrigins, hsts: deps.hsts };
}

/**
 * POST /api/search/ai
 *
 * A sentence in, a page of listings out — plus the filters that were applied
 * and a line saying how the words were read, so a misreading is visible and
 * correctable rather than mysterious.
 *
 * THE FALLBACK IS THE FEATURE. Every path that does not produce a spec runs
 * the words as an ordinary full-text search instead. A user who types a
 * sentence gets results either way; the model only decides whether those
 * results are filtered well.
 */
export async function aiSearch(req: Request, deps: AiRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ q: string }>(req, deps.cfg, {
      // Anonymous is allowed: search is the front door, and requiring an
      // account to use it would defeat the SEO the whole business rests on.
      requireAuth: false, limit: 'write', body: askBody,
      requireFlag: 'ai.chat_search',
    });
    id = ctx.requestId; origin = ctx.origin;

    // Keyed by account when there is one, by IP when there is not. An
    // anonymous flood is the guard's own rate limit; this is the per-actor
    // spend cap on top of it.
    const budgetKey = ctx.principal?.userId ?? `ip:${ctx.clientIp}`;
    const budget = await deps.aiLimiter.check(budgetKey);
    if (!budget.allowed) {
      // Not a 429: the request is fine and the user is not being throttled for
      // abuse — the AI budget for the day is spent, and plain search still
      // works. Saying so is more useful than "try again shortly".
      return json(
        {
          ...(await plainSearch(deps, body.q)),
          interpreted: null,
          reading: null,
          fallback: 'budget_exhausted',
        },
        ctxOf(ctx.requestId, ctx.origin, deps),
      );
    }

    const metered = deps.metered.for({
      ...(ctx.principal ? { actorId: ctx.principal.userId } : {}),
    });
    let interpreted;
    try {
      interpreted = await deps.chatSearch.withProvider(metered).interpret(body.q);
    } catch (err) {
      // A provider outage is not a search outage.
      if (!(err instanceof ProviderError)) throw err;
      return json(
        { ...(await plainSearch(deps, body.q)), interpreted: null, reading: null, fallback: 'provider_error' },
        ctxOf(ctx.requestId, ctx.origin, deps),
      );
    }

    if (!interpreted.spec) {
      return json(
        {
          ...(await plainSearch(deps, body.q)),
          interpreted: null,
          reading: interpreted.reading,
          fallback: interpreted.reason ?? 'no_spec',
        },
        ctxOf(ctx.requestId, ctx.origin, deps),
      );
    }

    // A place name is resolved by OUR gazetteer, never by the model — which
    // is why the model was never offered a coordinate field to fill in.
    const { place, ...spec } = interpreted.spec;
    const located = place ? await resolvePlace(deps, place) : null;

    const page = await deps.search.search({ ...spec, ...(located ?? {}) });
    return json(
      {
        ...page,
        interpreted: { ...spec, ...(located ?? {}) },
        reading: interpreted.reading,
        ...(place && !located ? { unresolvedPlace: place } : {}),
      },
      ctxOf(ctx.requestId, ctx.origin, deps),
    );
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/**
 * POST /api/listings/:id/describe
 *
 * Drafts copy from the listing's own facts. Owner only, and it does NOT save
 * anything: the draft is returned for the owner to read, edit and submit
 * themselves, because a description that appears in the box without being
 * read is a description nobody has checked.
 */
export async function describeListing(
  req: Request,
  listingId: string,
  deps: AiRouteDeps,
): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, {
      requireAuth: true, limit: 'write',
      requireFlag: 'ai.listing_builder',
    });
    id = ctx.requestId; origin = ctx.origin;

    const budget = await deps.aiLimiter.check(ctx.principal!.userId);
    if (!budget.allowed) {
      throw serviceUnavailable(
        'You have used the AI drafting budget for today. You can still write the description yourself.',
      );
    }

    // Fetched through the same read every other listing route uses, which
    // already applies the visibility rules — not a second implementation of
    // them. `isOwner` is then the ownership check: drafting copy for someone
    // else's listing is not a thing, and a 404 (not 403) keeps a stranger
    // from confirming the listing exists.
    const listing = await deps.listings.get(listingId, {
      userId: ctx.principal!.userId,
      role: ctx.principal!.role,
    });
    if (!listing.isOwner) throw notFound('Listing not found.');

    const facts = {
      mode: listing.mode,
      propertyType: listing.propertyType,
      roomType: listing.roomType,
      priceCents: listing.priceCents,
      beds: listing.beds,
      baths: listing.baths,
      sqft: listing.sqft,
      amenities: listing.amenities,
      city: listing.address.city,
    };

    const metered = deps.metered.for({
      actorId: ctx.principal!.userId,
      subjectType: 'listing',
      subjectId: listingId,
    });

    let out;
    try {
      out = await deps.listingBuilder.withProvider(metered).draft(facts);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      throw serviceUnavailable('Drafting is unavailable right now. You can write the description yourself.');
    }

    if (!out.draft) {
      // The owner is told WHY, in their own terms. "The draft mentioned a
      // heated garage, which is not on your listing" is actionable — they can
      // tick the amenity and try again. A bare failure is not.
      return json(
        {
          draft: null,
          reason: out.reason ?? 'unavailable',
          problems: out.problems.map((p) => ({
            kind: p.kind,
            phrase: p.phrase,
            explanation: explain(p.kind, p.subject),
          })),
        },
        ctxOf(ctx.requestId, ctx.origin, deps),
      );
    }

    return json(
      {
        draft: out.draft,
        // Stated in the response, not just in the docs: whatever the owner
        // does with this, the database will refuse to publish it until they
        // attest to it, and editing it re-arms that requirement.
        requiresAttestation: true,
        descriptionSource: 'ai',
      },
      ctxOf(ctx.requestId, ctx.origin, deps),
    );
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** The non-AI outcome. Deliberately the same call the ordinary search makes. */
async function plainSearch(deps: AiRouteDeps, q: string) {
  return deps.search.search({ q: q.slice(0, 200), sort: 'relevance' });
}

/**
 * Turns a place name into a filter, using our own gazetteer.
 *
 * Two attempts, cheapest first. A community association name ("Cathedral")
 * becomes a neighbourhood filter; an address ("2100 Victoria Ave") becomes the
 * neighbourhood that address sits in.
 *
 * Returns null when neither matches, and the caller says so rather than
 * silently searching the whole city — "we could not find that area" is a
 * useful answer; a city-wide result set presented as a neighbourhood search
 * is not.
 *
 * Note what does not happen here: the model is never asked where anything is.
 * It emits a name; Regina open data — which we own and may store, unlike
 * anything from Apple — decides where that name points.
 */
async function resolvePlace(
  deps: AiRouteDeps,
  place: string,
): Promise<{ neighbourhoodIds: string[] } | null> {
  const wanted = place.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (wanted.length < 3) return null;

  // Regina has about forty community associations, so listing them is one
  // small query — cheaper than a per-request LIKE against a name column, and
  // it lets the match be a containment test in either direction ("cathedral"
  // matching "Cathedral Area", and vice versa).
  const hoods = await deps.gazetteer.neighbourhoods('Regina', 'SK');
  const named = hoods.find((h) => {
    const name = h.name.toLowerCase();
    return name === wanted || name.includes(wanted) || wanted.includes(name);
  });
  if (named) return { neighbourhoodIds: [named.id] };

  const hits = await deps.gazetteer.suggest({ query: place, city: 'Regina', limit: 1 });
  const hood = hits[0]?.neighbourhood;
  if (!hood) return null;
  const matched = hoods.find((h) => h.name.toLowerCase() === hood.toLowerCase());
  return matched ? { neighbourhoodIds: [matched.id] } : null;
}

function explain(kind: string, subject: string): string {
  if (kind === 'unbacked_amenity') {
    return `The draft mentioned ${subject.replace(/_/g, ' ')}, which is not listed on this property. `
      + 'Add the amenity if the property has it, then try again.';
  }
  return `The draft made a claim about ${subject.replace(/_/g, ' ')} that Portage has no way to verify. `
    + 'Descriptions can only state facts from the listing itself.';
}

/** Bad request shape, surfaced so the route file owns its own validation errors. */
export const AI_BODY_ERROR = badRequest('Ask a question of at least three characters.');
