/**
 * The public pages.
 *
 * These call the SAME services the JSON API calls — `SearchService`,
 * `ListingService` — not the HTTP endpoints. That is the point of having the
 * modules: a page is a second presentation of the same decision, not a second
 * implementation of it, so the visibility rules, the price bands and the
 * publish guard cannot be right in one and wrong in the other.
 *
 * Server-rendered, and that is a product decision rather than a technical
 * one. analysis/02 puts SEO as the moat against Realtor.ca: a listing has to
 * arrive from a Google result as complete HTML with a price in it, on a phone,
 * on Regina mobile data. A client-rendered shell that fetches its own content
 * is the one architecture that cannot do that.
 */
import { html, raw, jsonScript, safeUrl, type Html } from './html.js';
import { page, money, facts, amenityLabel, csrfField, type Flash, type Viewer } from './layout.js';
import { iconSprite } from './icons.js';
import type { SearchPage, SearchResultCard } from '../modules/search/service.js';
import type { ListingView } from '../modules/listings/service.js';

// ── home ────────────────────────────────────────────────────────────────────

export function homePage(opts: Flash & {
  viewer: Viewer | null;
  recent: SearchResultCard[];
  liveCount: number;
}): string {
  return page(
    {
      title: 'Rent or buy direct from owners in Regina',
      description:
        'Portage lists homes for rent and sale in Regina, Saskatchewan, posted '
        + 'directly by their owners. No commission, no listing fee, no agent in between.',
      viewer: opts.viewer,
      notice: opts.notice, error: opts.error,
      path: '/',
    },
    html`
<section class="hero"><div class="wrap">
  <h1>Homes in Regina, direct from the people who own them</h1>
  <p>
    No commission and no listing fee — for owners or for renters. Every listing
    here was posted by the person who owns the property.
  </p>
  <form class="searchbar" action="/search" method="get" role="search">
    <input type="text" name="q" placeholder="Try: two bed under $1500 with parking"
           aria-label="Search listings">
    <button class="btn btn-primary" type="submit">Search</button>
  </form>
  <p class="small muted" style="margin-top:10px">
    ${opts.liveCount > 0
      ? html`${opts.liveCount.toLocaleString('en-CA')} live listing${opts.liveCount === 1 ? '' : 's'} right now.`
      : html`Regina listings are opening up now — be among the first to post one.`}
  </p>
</div></section>

<div class="wrap" style="padding:28px 20px 0">
  <h2>Recently listed</h2>
  ${opts.recent.length > 0
    ? html`<div class="grid">${opts.recent.map(card)}</div>`
    : html`<div class="empty">
             No live listings yet. <a href="/dashboard/listings/new">Post the first one.</a>
           </div>`}
</div>`,
  );
}

// ── search ──────────────────────────────────────────────────────────────────

export interface SearchPageOptions extends Flash {
  viewer: Viewer | null;
  query: string;
  results: SearchPage;
  /** Present when the AI read the query into filters. */
  reading?: string | null;
  /** Why the AI path did not produce filters, when it did not. */
  fallback?: string | null;
  /** The filter panel, already built. Absent on the pages that reuse this
   *  template for a 404, where offering filters would be nonsense. */
  filters?: Html | null;
  chips?: Html | null;
  /** The sort in force, so the control reflects what actually happened. */
  sort?: string | null;
  /** Carried into the sort form so changing it keeps every other filter. */
  hidden?: ReadonlyArray<[string, string]> | null;
}

export function searchPage(o: SearchPageOptions): string {
  const n = o.results.results.length;
  return page(
    {
      title: o.query ? `${o.query} — Regina listings` : 'Search Regina listings',
      description: 'Search owner-direct homes for rent and sale in Regina, Saskatchewan.',
      viewer: o.viewer,
      notice: o.notice, error: o.error,
      path: '/search',
    },
    html`
${iconSprite()}
<div class="wrap" style="padding:22px 20px 0">
  <form class="searchbar" action="/search" method="get" role="search">
    <input type="text" name="q" value="${o.query}" placeholder="Search listings"
           aria-label="Search listings">
    <button class="btn btn-primary" type="submit">Search</button>
  </form>

  ${o.filters ?? null}
  ${o.chips ?? null}

  ${o.reading
    ? html`<p class="notice" style="margin-top:14px">Read as: ${o.reading}</p>`
    : null}
  ${o.fallback && !o.reading
    ? html`<p class="notice notice-warn" style="margin-top:14px">
             ${fallbackMessage(o.fallback)}
           </p>`
    : null}

  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0 12px">
    <p class="muted small" style="margin:0">
      ${n === 0 ? 'No matches' : `${n} listing${n === 1 ? '' : 's'}`}
      ${o.query ? html` for “${o.query}”` : null}
    </p>
    ${/* A GET form, like the filters: changing the sort is a new URL, and it
          carries every filter forward in hidden fields rather than losing
          them — which is what a bare <select> with an onchange would do the
          moment the script failed. */ null}
    ${o.sort
      ? html`
      <form method="get" action="/search" style="margin-left:auto;display:flex;gap:6px">
        ${(o.hidden ?? []).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
        <label for="sort" class="small muted" style="margin:0;align-self:center">Sort</label>
        <select id="sort" name="sort" style="width:auto;padding:6px 10px;font-size:13px">
          ${SORT_COPY.map(([value, label]) => html`
            <option value="${value}" ${o.sort === value ? raw('selected') : null}>${label}</option>`)}
        </select>
        <button class="btn btn-sm" type="submit">Apply</button>
      </form>`
      : null}
  </div>

  ${n > 0
    ? html`<div class="grid">${o.results.results.map(card)}</div>`
    : html`<div class="empty">
             <p>Nothing matched that search.</p>
             <p class="small">Try fewer words, or a wider price range.</p>
           </div>`}
</div>`,
  );
}

/**
 * Why the AI path produced nothing, in the user's terms.
 *
 * The results below are a real search either way, so this explains rather
 * than apologises — "we could not read that" with no results underneath is a
 * failure; with results underneath it is a note.
 */
/** Sort values in the order people reach for them, with readable labels. */
const SORT_COPY: ReadonlyArray<[string, string]> = [
  ['newest', 'Newest first'],
  ['price_asc', 'Price: low to high'],
  ['price_desc', 'Price: high to low'],
  ['relevance', 'Best match'],
];

function fallbackMessage(reason: string): string {
  switch (reason) {
    case 'not_confident':
      return 'That did not look like a property search, so these are plain text matches.';
    case 'budget_exhausted':
      return 'Smart search is rested for today — showing plain text matches instead.';
    case 'contradictory':
      return 'Those filters cancelled each other out, so these are plain text matches.';
    default:
      return 'Smart search is unavailable right now — showing plain text matches instead.';
  }
}

// ── listing detail ──────────────────────────────────────────────────────────

export function listingPage(opts: Flash & {
  viewer: Viewer | null;
  listing: ListingView;
  origin: string;
}): string {
  const l = opts.listing;
  const address = `${l.address.addressLine}${l.address.unit ? ` #${l.address.unit}` : ''}`;
  const summary = `${money(l.priceCents)}${l.mode === 'rent' ? '/month' : ''} · ${facts(l)} · ${l.address.city}`;

  return page(
    {
      title: `${l.title} — ${l.address.city}`,
      description: (l.description ?? summary).slice(0, 300),
      viewer: opts.viewer,
      notice: opts.notice, error: opts.error,
      path: `/listings/${l.id}`,
      // Schema.org, so a Google result shows the price and beds rather than a
      // bare blue link. Built from the row, never from the description — the
      // description is prose and may be AI-written; these are facts.
      structuredData: jsonScript({
        '@context': 'https://schema.org',
        '@type': l.mode === 'rent' ? 'Apartment' : 'SingleFamilyResidence',
        name: l.title,
        address: {
          '@type': 'PostalAddress',
          streetAddress: address,
          addressLocality: l.address.city,
          addressRegion: l.address.province,
          postalCode: l.address.postalCode ?? undefined,
          addressCountry: 'CA',
        },
        numberOfBedrooms: l.beds ?? undefined,
        numberOfBathroomsTotal: l.baths ?? undefined,
        floorSize: l.sqft ? { '@type': 'QuantitativeValue', value: l.sqft, unitCode: 'FTK' } : undefined,
        url: `${opts.origin}/listings/${l.id}`,
      }),
    },
    html`
<div class="wrap detail">
  <div>
    <div class="gallery">
      ${l.photos.length > 0
        ? html`<img class="main" src="${safeUrl(`/media/${l.photos[0]!.storageKey}`)}"
                    alt="${l.title}" width="960" height="600">`
        : html`<div class="main">No photos yet</div>`}
    </div>

    <h1 style="margin-top:20px">${l.title}</h1>
    <p class="muted" style="margin:0 0 4px">${address}, ${l.address.city}, ${l.address.province}</p>

    <div class="facts-row">
      ${l.beds !== null ? factBlock(String(l.beds), 'bedrooms') : null}
      ${l.baths !== null ? factBlock(String(l.baths), 'bathrooms') : null}
      ${l.sqft !== null ? factBlock(l.sqft.toLocaleString('en-CA'), 'sq ft') : null}
      ${factBlock(l.propertyType.replace(/_/g, ' '), 'type')}
    </div>

    ${tabs(l)}
  </div>

  <aside class="aside">
    <div class="price">${money(l.priceCents)}${l.mode === 'rent' ? html`<small class="muted" style="font-size:15px;font-weight:500"> /month</small>` : null}</div>
    <p class="small muted" style="margin:4px 0 16px">
      ${l.mode === 'rent' ? 'Rent, direct from the owner' : 'For sale, direct from the owner'}
    </p>

    ${l.isOwner
      ? html`<a class="btn" href="/dashboard/listings">Manage this listing</a>`
      : !opts.viewer
      ? html`
        <a class="btn btn-primary" style="width:100%"
           href="/signin?next=${encodeURIComponent(`/listings/${l.id}`)}">
          Sign in to message the owner
        </a>
        <p class="small muted" style="margin-top:12px">
          Free, and it is how we keep a record if something goes wrong.
        </p>`
      : html`
        <form method="post" action="/listings/${l.id}/enquire" class="stack">
          ${csrfField(opts.viewer!)}
          <div class="field">
            <label for="msg">Message the owner</label>
            <textarea id="msg" name="body" rows="4" required
              placeholder="Hi — is this still available? I'd like to arrange a viewing."></textarea>
          </div>
          <button class="btn btn-primary" type="submit" style="width:100%">Send enquiry</button>
        </form>
        <p class="small muted" style="margin-top:12px">
          Never send money or share banking details before seeing the property in person.
          <a href="/reports/new?listing=${l.id}">Report this listing</a>
        </p>`}
  </aside>
</div>`,
  );
}

function factBlock(value: string, label: string): Html {
  return html`<div class="fact"><b>${value}</b><span>${label}</span></div>`;
}

/**
 * The three tabs from the design canvas.
 *
 * Progressive enhancement, deliberately: every panel is in the HTML and
 * visible with JavaScript off, and the script below turns them into tabs.
 * A listing whose details only appear after a script runs is a listing Google
 * indexes without its details, which defeats the reason the page is
 * server-rendered at all.
 */
function tabs(l: ListingView): Html {
  return html`
<div class="tabs" role="tablist">
  <button role="tab" aria-selected="true" aria-controls="p-about" id="t-about">About</button>
  <button role="tab" aria-selected="false" aria-controls="p-amenities" id="t-amenities">Amenities</button>
  <button role="tab" aria-selected="false" aria-controls="p-details" id="t-details">Details</button>
</div>

<section class="tabpanel" id="p-about" role="tabpanel" aria-labelledby="t-about">
  ${l.description
    ? html`<p style="white-space:pre-wrap">${l.description}</p>`
    : html`<p class="muted">The owner has not written a description yet.</p>`}
  ${l.descriptionSource !== 'human'
    ? html`<p class="small muted">This description was drafted with AI and confirmed as
             accurate by the owner.</p>`
    : null}
</section>

<section class="tabpanel" id="p-amenities" role="tabpanel" aria-labelledby="t-amenities" hidden>
  ${l.amenities.length > 0
    ? html`<div>${l.amenities.map((a) => html`<span class="chip chip-tint">${amenityLabel(a)}</span>`)}</div>`
    : html`<p class="muted">No amenities listed.</p>`}
</section>

<section class="tabpanel" id="p-details" role="tabpanel" aria-labelledby="t-details" hidden>
  <table style="border-collapse:collapse;font-size:14px">
    ${row('Listing type', l.mode === 'rent' ? 'For rent' : 'For sale')}
    ${row('Property type', l.propertyType.replace(/_/g, ' '))}
    ${l.roomType ? row('Room type', l.roomType) : null}
    ${row('City', `${l.address.city}, ${l.address.province}`)}
    ${l.address.postalCode ? row('Postal code', l.address.postalCode) : null}
    ${l.publishedAt ? row('Listed', l.publishedAt.toLocaleDateString('en-CA')) : null}
  </table>
</section>

<script>${raw(TAB_SCRIPT)}</script>`;
}

function row(label: string, value: string): Html {
  return html`<tr>
    <td style="padding:7px 22px 7px 0;color:#7b8698">${label}</td>
    <td style="padding:7px 0">${value}</td>
  </tr>`;
}

/**
 * Twelve lines, inline, no framework.
 *
 * Written as a string constant rather than a separate asset so the page has
 * no second request, and kept free of any interpolation — nothing user-
 * supplied goes near it, which is why `raw()` above is safe.
 */
const TAB_SCRIPT = `
(function () {
  var tabs = document.querySelectorAll('[role=tab]');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
    });
  });
})();`;

// ── shared card ─────────────────────────────────────────────────────────────

function card(l: SearchResultCard): Html {
  return html`
<a class="card" href="/listings/${l.id}">
  ${l.photo
    ? html`<img class="ph" src="${safeUrl(`/media/${l.photo.storageKey}`)}" alt=""
                loading="lazy" width="400" height="300">`
    : html`<div class="ph">No photo</div>`}
  <div class="body">
    <div class="price">${money(l.priceCents)}${l.mode === 'rent' ? html`<small> /mo</small>` : null}</div>
    <div class="addr">${l.address.addressLine}</div>
    <div class="facts">${facts(l)}</div>
  </div>
</a>`;
}

// ── sign in ─────────────────────────────────────────────────────────────────

/**
 * Sign-in providers, rendered only for the ones actually configured.
 *
 * A "Continue with Google" button on a deployment with no Google client id is
 * a button that takes you to a 500. The env loader already refuses a
 * half-configured provider; this refuses to advertise an absent one.
 */
function oauthButtons(providers: readonly string[], next: string | null | undefined): Html {
  if (providers.length === 0) return html``;
  const q = next ? `?next=${encodeURIComponent(next)}` : '';
  return html`
<div style="margin-bottom:18px">
  ${providers.map((p) => html`
  <a class="btn" style="width:100%;margin-bottom:8px"
     href="/api/auth/oauth/${p}${q}">Continue with ${PROVIDER_NAMES[p] ?? p}</a>`)}
  <div style="display:flex;align-items:center;gap:10px;color:var(--muted);
              font-size:12.5px;margin:14px 0 2px">
    <span style="flex:1;height:1px;background:var(--line)"></span>or
    <span style="flex:1;height:1px;background:var(--line)"></span>
  </div>
</div>`;
}

const PROVIDER_NAMES: Record<string, string> = { google: 'Google', facebook: 'Facebook' };

export function signInPage(opts: Flash & {
  next?: string | null;
  /** Providers with credentials configured. Empty on most deployments. */
  providers?: readonly string[];
}): string {
  return page(
    { title: 'Sign in', viewer: null, path: '/signin', notice: opts.notice, error: opts.error },
    html`
<div class="wrap" style="max-width:400px;padding:52px 20px">
  <h1>Sign in</h1>
  ${opts.error ? html`<p class="notice notice-warn">${opts.error}</p>` : null}
  ${oauthButtons(opts.providers ?? [], opts.next)}
  <form method="post" action="/signin" class="stack">
    ${opts.next ? html`<input type="hidden" name="next" value="${opts.next}">` : null}
    <div class="field">
      <label for="email">Email</label>
      <input id="email" type="email" name="email" required autocomplete="email">
    </div>
    <div class="field">
      <label for="pw">Password</label>
      <input id="pw" type="password" name="password" required autocomplete="current-password">
      <p class="small" style="margin:6px 0 0">
        <a href="/forgot-password">Forgotten it?</a>
      </p>
    </div>
    <button class="btn btn-primary" type="submit" style="width:100%">Sign in</button>
  </form>
  <p class="small muted" style="margin-top:18px">
    No account yet? <a href="/signup">Create one</a>. It is free, and always will be.
  </p>
</div>`,
  );
}
