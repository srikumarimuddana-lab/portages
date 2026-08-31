/**
 * Page routes for the signed-in and staff surfaces, plus media.
 *
 * Same shape as routes.ts: resolve the viewer, call a service, render. The
 * one piece of real logic in this file is `mediaRoute`, and it is here rather
 * than in a module because it is entirely about HTTP.
 */
import { html } from './html.js';
import { page } from './layout.js';
import {
  signUpPage, ownerListingsPage, newListingPage, inboxPage, threadPage,
} from './pages-app.js';
import {
  queuePage, listingReviewPage, messageReviewPage, flagsPage,
} from './pages-admin.js';
import { AMENITIES, PROPERTY_TYPES } from '../modules/listings/policy.js';
import { SESSION_COOKIE, parseCookies } from '../lib/session.js';
import type { Viewer } from './layout.js';
import type { App } from '../http/app.js';
import type { QueueState } from '../modules/admin/moderation.js';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; "
    + "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; "
    + "form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // Signed-in pages must never sit in a shared cache. An inbox served from a
  // CDN to the next visitor is the worst bug this file could have.
  'cache-control': 'private, no-store',
};

function respond(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML_HEADERS });
}

async function viewerOf(app: App, req: Request): Promise<Viewer | null> {
  const token = parseCookies(req.headers.get('cookie') ?? undefined)[SESSION_COOKIE];
  if (!token) return null;
  const s = await app.auth.resolveSession(token);
  return s ? { userId: s.userId, role: s.role } : null;
}

/** Sends an anonymous visitor to sign in, and remembers where they were going. */
function toSignIn(req: Request): Response {
  const url = new URL(req.url);
  const next = encodeURIComponent(url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : ''));
  return Response.redirect(new URL(`/signin?next=${next}`, req.url).toString(), 302);
}

/**
 * Staff pages answer 404, not 403, to everyone else.
 *
 * The same rule the API's `requireRole` follows, for the same reason: a 403
 * confirms the page exists and is worth attacking. A stranger who guesses
 * /admin/queue must learn nothing from the answer — including that they
 * guessed a real URL.
 */
function notFound(viewer: Viewer | null): Response {
  return respond(
    page({ title: 'Not found', viewer }, html`
      <div class="wrap"><div class="empty">
        <h1>Not found</h1>
        <p>That page is not here. <a href="/">Back to Portage</a></p>
      </div></div>`),
    404,
  );
}

// ── public ──────────────────────────────────────────────────────────────────

export async function signUpRoute(req: Request, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  if (viewer) return Response.redirect(new URL('/', req.url).toString(), 302);
  return respond(signUpPage({}));
}

// ── owner ───────────────────────────────────────────────────────────────────

export async function ownerListingsRoute(req: Request, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  if (!viewer) return toSignIn(req);
  const listings = await app.listings.listForOwner(viewer.userId, { limit: 50 });
  return respond(ownerListingsPage({ viewer, listings }));
}

export async function newListingRoute(req: Request, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  if (!viewer) return toSignIn(req);
  // The form only mentions AI drafting when the switch is actually on, so a
  // switched-off feature is absent rather than advertised and then refused.
  const aiEnabled = await app.flags.isEnabled('ai.listing_builder', viewer.userId);
  return respond(newListingPage({
    viewer, propertyTypes: PROPERTY_TYPES, amenities: AMENITIES, aiEnabled,
  }));
}

// ── messaging ───────────────────────────────────────────────────────────────

export async function inboxRoute(req: Request, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  if (!viewer) return toSignIn(req);
  const threads = await app.messaging.listThreads(viewer.userId, { limit: 50 });
  return respond(inboxPage({ viewer, threads }));
}

export async function threadRoute(req: Request, id: string, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  if (!viewer) return toSignIn(req);
  try {
    // getThread already refuses a thread the caller is not party to, with a
    // 404 — so this page inherits that check rather than repeating it.
    const thread = await app.messaging.getThread(id, viewer.userId);
    return respond(threadPage({ viewer, thread }));
  } catch {
    return notFound(viewer);
  }
}

// ── staff ───────────────────────────────────────────────────────────────────

const STAFF_ROLES = ['staff', 'admin'];

export async function queueRoute(req: Request, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  if (!viewer || !STAFF_ROLES.includes(viewer.role)) return notFound(viewer);

  const asked = new URL(req.url).searchParams.get('state');
  const state: QueueState =
    asked === 'approved' || asked === 'rejected' ? asked : 'open';

  const [items, stats] = await Promise.all([
    app.moderation.list({ state, limit: 50 }),
    app.moderation.stats(),
  ]);
  return respond(queuePage({ viewer, items, stats, state }));
}

export async function listingReviewRoute(req: Request, id: string, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  if (!viewer || !STAFF_ROLES.includes(viewer.role)) return notFound(viewer);

  try {
    const l = await app.listings.get(id, { userId: viewer.userId, role: viewer.role });
    const reports = await app.reports.forSubject('listing', id);
    return respond(listingReviewPage({
      viewer,
      listing: {
        id: l.id, title: l.title, description: l.description,
        descriptionSource: l.descriptionSource, priceCents: l.priceCents,
        mode: l.mode, beds: l.beds, baths: l.baths, sqft: l.sqft,
        amenities: l.amenities, status: l.status,
        address: {
          addressLine: l.address.addressLine,
          city: l.address.city,
          province: l.address.province,
        },
      },
      // Signals come from the queue item when there is one; an empty list is a
      // listing queued for a reason other than a heuristic, which is fine.
      signals: [],
      reports: reports.map((r) => ({
        kind: r.kind, detail: r.detail, createdAt: r.createdAt,
      })),
    }));
  } catch {
    return notFound(viewer);
  }
}

export async function messageReviewRoute(req: Request, id: string, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  if (!viewer || !STAFF_ROLES.includes(viewer.role)) return notFound(viewer);

  try {
    const m = await app.messaging.reviewMessage(id, {
      userId: viewer.userId,
      role: viewer.role as 'staff' | 'admin',
    });
    return respond(messageReviewPage({ viewer, message: m }));
  } catch {
    return notFound(viewer);
  }
}

export async function flagsRoute(req: Request, app: App): Promise<Response> {
  const viewer = await viewerOf(app, req);
  if (!viewer || !STAFF_ROLES.includes(viewer.role)) return notFound(viewer);

  const [flags, cache] = await Promise.all([app.flags.list(), app.flags.cacheState()]);
  return respond(flagsPage({ viewer, flags, cache }));
}

// ── media ───────────────────────────────────────────────────────────────────

/** Storage keys this codebase mints. Anything else is not one of ours. */
const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$/;

/**
 * GET /media/:key — redirects to the object, never proxies it.
 *
 * TWO CHECKS, and both are load-bearing.
 *
 * 1. THE KEY SHAPE. A path segment from a URL is about to become an object
 *    key. `..` and backslashes are refused outright rather than normalised,
 *    because normalising is where traversal bugs live.
 *
 * 2. THE KEY MUST BELONG TO A LISTING THE VIEWER MAY SEE. Without this,
 *    anyone holding a key could fetch the photos of a DRAFT listing — one
 *    that has never been public and may show the inside of someone's home
 *    while they are deciding whether to list it. Photos of live listings are
 *    public; photos of drafts are not, and the storage layer cannot tell them
 *    apart because a key is just a key.
 *
 * The bytes never pass through this server: it answers with a redirect to the
 * CDN URL when the bucket has one, or to a short-lived presigned GET when it
 * does not. That is the same direct-to-storage rule the upload path follows.
 */
export async function mediaRoute(req: Request, key: string, app: App): Promise<Response> {
  if (!KEY_SHAPE.test(key) || key.includes('..') || key.includes('\\')) {
    return new Response('Not found', { status: 404 });
  }
  if (!app.storage) {
    return new Response('Media storage is not configured.', { status: 503 });
  }

  const viewer = await viewerOf(app, req);
  const visible = await app.db.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM listing_media m
       JOIN listings l ON l.id = m.listing_id
      WHERE m.storage_key = $1
        AND (l.status IN ('live', 'paused', 'rented', 'sold')
             OR l.owner_id = $2
             OR $3)`,
    [key, viewer?.userId ?? null, viewer?.role === 'staff' || viewer?.role === 'admin'],
  );
  if (Number(visible.rows[0]?.n ?? 0) === 0) {
    return new Response('Not found', { status: 404 });
  }

  const url = app.storage.publicUrl(key) ?? app.storage.presignGet(key, { expiresIn: 300 });
  return new Response(null, {
    status: 302,
    headers: {
      location: url,
      // A permanent CDN URL is immutable — keys are content-addressed, so the
      // bytes behind one never change. A presigned URL expires, so the
      // redirect to it must not outlive it.
      'cache-control': app.storage.publicUrl(key)
        ? 'public, max-age=86400'
        : 'private, max-age=240',
    },
  });
}
