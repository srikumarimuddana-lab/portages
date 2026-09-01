/**
 * Page routes.
 *
 * Deliberately thin. Each handler resolves the viewer, calls a service, and
 * hands the result to a template — there is no business logic here, because
 * every decision these pages present has already been made and tested in a
 * module.
 *
 * WHY THESE ARE NOT `guard()`. The guard is built for a JSON API: it refuses
 * with status codes and JSON error bodies, and it enforces CSRF on writes by
 * requiring a header no plain HTML form can send. A browser navigating to a
 * page needs the opposite behaviours — a redirect to sign-in rather than a
 * 401, and a readable page rather than `{"error":...}`. So pages resolve the
 * session directly and share the same `AuthService`, while every WRITE a page
 * performs still posts to the JSON API, where the guard applies in full.
 *
 * That split is the point: the pages are a read surface. Nothing here mutates
 * anything.
 */
import { CSRF_COOKIE, SESSION_COOKIE, parseCookies } from '../lib/session.js';
import { homePage, searchPage, listingPage, signInPage } from './pages.js';
import { searchFilters, activeFilters } from './pages-parts.js';
import { saveSearchControl, suggestName } from './pages-saved.js';
import {
  filterValuesFrom, specFrom, activeCount, chipsFor, clearHref, hiddenFields, specToQuery,
} from './search-query.js';
import { AMENITY_GROUPS, PROPERTY_TYPES } from '../modules/listings/policy.js';
import { SORT_ORDERS } from '../modules/search/spec.js';
import { contentSecurityPolicy } from './headers.js';
import { flashOf } from './form.js';
import type { Viewer } from './layout.js';
import type { App } from '../http/app.js';

/** Pages are HTML, and the security headers differ from the API's. */
function respond(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The API sets its own CSP for JSON. This one is for a document, and it
      // is what turns the escaping in html.ts from the only defence into the
      // first of two: even a missed interpolation cannot load a remote script.
      //
      // No `uploadOrigin` here on purpose. Nothing on a public page uploads
      // anything, so `connect-src` stays at 'self' and these pages cannot talk
      // to the bucket at all.
      'content-security-policy': contentSecurityPolicy(),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      ...extra,
    },
  });
}

/**
 * Who is looking, or null.
 *
 * Never throws and never redirects: a page that renders differently when
 * signed in must still render when the session has expired mid-visit, and the
 * public pages are public.
 */
async function viewerOf(app: App, req: Request): Promise<Viewer | null> {
  const cookies = parseCookies(req.headers.get('cookie') ?? undefined);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await app.auth.resolveSession(token);
  if (!session) return null;
  // The CSRF token comes from its own cookie, which is deliberately readable.
  // Every form the page renders echoes it back in a hidden field.
  return {
    userId: session.userId, role: session.role,
    email: session.email, emailVerified: session.emailVerified,
    ...(cookies[CSRF_COOKIE] ? { csrfToken: cookies[CSRF_COOKIE] } : {}),
  };
}

export async function homeRoute(req: Request, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  // One query, not two: the count comes from the same live-listing search the
  // grid below it renders, so the headline number and the cards can never
  // disagree.
  const recent = await app.search.search({ sort: 'newest', limit: 8 });
  return respond(homePage({
    viewer,
    recent: recent.results,
    liveCount: recent.results.length,
    ...flashOf(new URL(req.url)),
  }));
}

export async function searchRoute(req: Request, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  const url = new URL(req.url);
  const params = url.searchParams;

  // The URL is the search. Everything the panel offers is read back out of it
  // and handed to the same `parse` the JSON API uses, so a filtered search is
  // a link — bookmarkable, shareable, indexable — rather than a state a script
  // is holding.
  const values = filterValuesFrom(params);
  const spec = specFrom(values, 24);

  // Natural-language interpretation stays a separate, opt-in request. A slow
  // model can never be the reason this page is slow.
  const results = await app.search.search(spec);

  // Only for a signed-in visitor, and only to decide whether the control says
  // "save" or "saved" — an anonymous search costs no extra query.
  const saved = viewer ? await app.savedSearches.list(viewer.userId) : [];

  return respond(searchPage({
    viewer,
    query: values.q ?? '',
    results,
    sort: results.sort,
    hidden: hiddenFields(params),
    filters: searchFilters({
      values,
      propertyTypes: PROPERTY_TYPES,
      amenityGroups: AMENITY_GROUPS,
      sorts: SORT_ORDERS,
      activeCount: activeCount(values),
      clearHref: clearHref(values),
    }),
    chips: activeFilters({ chips: chipsFor(params, values) }),
    saveControl: saveSearchControl({
      viewer,
      query: params.toString(),
      suggestedName: suggestName(values),
      // Compared on the normalised query rather than on the raw URL, so the
      // same search reached by a different route — a chip removed, filters in
      // another order — is recognised as already saved.
      alreadySaved: saved.some((s) => specToQuery(s.spec) === specToQuery(spec)),
    }),
    ...flashOf(url),
  }));
}


export async function listingRoute(req: Request, id: string, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  try {
    // Same read the JSON API uses, so a draft is invisible to a stranger here
    // for exactly the reason it is invisible there — one implementation of the
    // visibility rule, not two.
    const listing = await app.listings.get(id, {
      userId: viewer?.userId ?? null,
      role: viewer?.role ?? 'user',
    });
    const origin = app.env.publicOrigin || new URL(req.url).origin;
    return respond(listingPage({ viewer, listing, origin, ...flashOf(new URL(req.url)) }));
  } catch {
    return respond(notFoundPage(viewer), 404);
  }
}

export async function signInRoute(req: Request, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  if (viewer) return Response.redirect(new URL('/', req.url).toString(), 302);
  const next = new URL(req.url).searchParams.get('next');
  return respond(signInPage({
    next,
    // Only the ones with credentials. A button that leads to a 500 is worse
    // than no button, and the env loader already refuses half a provider.
    providers: Object.keys(app.env.oauth),
    ...flashOf(new URL(req.url)),
  }));
}

function notFoundPage(viewer: Viewer | null): string {
  // Built through the same shell so a 404 is a page rather than a stack trace,
  // and so the header still offers a way back to something that exists.
  return searchPage({
    viewer,
    query: '',
    results: { results: [], sort: 'newest' },
    fallback: null,
  }).replace(
    '<p class="muted small"',
    '<p class="notice notice-warn">That listing is no longer here. It may have been '
    + 'rented, sold, or taken down.</p><p class="muted small"',
  );
}
