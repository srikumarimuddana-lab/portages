/**
 * The page shell and the design system.
 *
 * Tokens are lifted from design/*.dc.html so the built pages and the design
 * canvas cannot drift: ink #12151c, borders #e6e8ee, muted #7b8698, the blue
 * pair #24528f / #356dbe, tint #eaf1fb.
 *
 * The CSS is inlined rather than served as a file. At this size (~6KB) that is
 * one fewer round trip on the page whose speed matters most — a listing page
 * arriving from a Google result, on a phone, on Regina mobile data. A separate
 * stylesheet becomes worth it when it stops fitting in the first packet burst.
 */
import { html, raw, escape, type Html } from './html.js';

export interface Viewer {
  userId: string;
  role: 'user' | 'staff' | 'admin';
  /**
   * The CSRF token for this session, read from its cookie.
   *
   * Carried on the viewer rather than threaded through every page's options
   * because it is needed by every form on every signed-in page, and a
   * parameter that must be passed everywhere is a parameter that will one day
   * be forgotten on the one page that mattered. `csrfField` throws when it is
   * absent, so a missing token is a loud failure at render time rather than a
   * form that silently 403s in production.
   */
  csrfToken?: string | undefined;
}

/** The one-shot messages a redirect can carry into any page. */
export interface Flash {
  notice?: string | null | undefined;
  error?: string | null | undefined;
}

export interface PageOptions extends Flash {
  title: string;
  /** The meta description. Absent means no tag, rather than an empty one. */
  description?: string | undefined;
  viewer?: Viewer | null;
  /** Canonical path. SEO is the moat, so this is not optional in practice. */
  path?: string | undefined;
  /** JSON-LD, already built. Rendered inside a guarded script block. */
  structuredData?: Html | undefined;
  /** Extra markup for <head>, e.g. og: tags on a listing page. */
  head?: Html | undefined;
  /*
   * `notice` and `error` come from Flash above. They are rendered by the
   * shell rather than by each page, because a redirect whose message nothing
   * displays is a form that appears to do nothing — and the page that forgets
   * to render it is always the one whose failure mattered.
   */
  bodyClass?: string | undefined;
}

const CSS = `
:root {
  --ink: #12151c;
  --ink-2: #3c4454;
  --muted: #7b8698;
  --muted-2: #9aa4b5;
  --line: #e6e8ee;
  --line-2: #dde1e9;
  --surface: #eef0f4;
  --tint: #eaf1fb;
  --accent: #24528f;
  --accent-2: #356dbe;
  --bg: #ffffff;
  --radius: 10px;
  --font: 'Golos Text', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 var(--font);
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
img { max-width: 100%; display: block; }
h1, h2, h3 { line-height: 1.2; margin: 0 0 .4em; letter-spacing: -0.01em; }
h1 { font-size: 26px; } h2 { font-size: 19px; } h3 { font-size: 16px; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 20px; }

/* header */
.site { border-bottom: 1px solid var(--line); background: var(--bg);
  position: sticky; top: 0; z-index: 20; }
.site .wrap { display: flex; align-items: center; gap: 20px; height: 60px; }
.brand { font-weight: 700; font-size: 18px; color: var(--ink); letter-spacing: -0.02em; }
.brand:hover { text-decoration: none; }
.brand span { color: var(--accent-2); }
.site nav { margin-left: auto; display: flex; align-items: center; gap: 18px; }
.site nav a:not(.btn) { color: var(--ink-2); font-size: 14px; font-weight: 500; }
/* :not(.btn) is load-bearing. Without it this rule's specificity (0,2,1)
   beats .btn-primary (0,1,0), and the header's "Create account" button
   renders dark blue on dark blue — unreadable, and invisible in code review
   because both rules are individually correct. Caught by looking at it. */

/* buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  padding: 9px 15px; border-radius: 8px; border: 1px solid var(--line-2);
  background: var(--bg); color: var(--ink); font: 500 14px/1 var(--font);
  cursor: pointer; text-decoration: none;
}
.btn:hover { background: var(--surface); text-decoration: none; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent-2); }
.btn-sm { padding: 6px 11px; font-size: 13px; }

/* forms */
input[type=text], input[type=email], input[type=password], input[type=number],
select, textarea {
  width: 100%; padding: 10px 12px; border: 1px solid var(--line-2);
  border-radius: 8px; font: 15px var(--font); color: var(--ink); background: var(--bg);
}
input:focus, select:focus, textarea:focus {
  outline: 2px solid var(--accent-2); outline-offset: -1px; border-color: var(--accent-2);
}
label { display: block; font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 5px; }
.field { margin-bottom: 14px; }

/* search */
.searchbar { display: flex; gap: 8px; }
.searchbar input { flex: 1; }
.hero { padding: 46px 0 34px; border-bottom: 1px solid var(--line); }
.hero h1 { font-size: 36px; max-width: 24ch; }
.hero p { color: var(--muted); margin: 0 0 22px; max-width: 52ch; font-size: 16px; }

/* cards */
.grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fill, minmax(266px, 1fr)); }
.card { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden;
  background: var(--bg); display: flex; flex-direction: column; }
.card:hover { border-color: var(--muted-2); }
.card .ph { aspect-ratio: 4/3; background: var(--surface); display: grid;
  place-items: center; color: var(--muted-2); font-size: 13px; }
.card .body { padding: 12px 13px 14px; }
.card .price { font-weight: 700; font-size: 17px; letter-spacing: -0.01em; }
.card .price small { font-weight: 500; color: var(--muted); font-size: 13px; }
.card .addr { color: var(--ink-2); font-size: 14px; margin: 3px 0 7px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .facts { color: var(--muted); font-size: 13px; }

/* chips + badges */
.chip { display: inline-block; padding: 3px 9px; border-radius: 999px;
  background: var(--surface); color: var(--ink-2); font-size: 12.5px; margin: 0 5px 5px 0; }
.chip-tint { background: var(--tint); color: var(--accent); }
.badge { display: inline-block; padding: 2px 8px; border-radius: 5px;
  font-size: 12px; font-weight: 600; }
.badge-live { background: #e8f5ec; color: #1c6b3a; }
.badge-review { background: #fdf3e3; color: #8a5a10; }
.badge-draft { background: var(--surface); color: var(--ink-2); }
/* The one that matters most during an incident: "Off" on the kill-switch
   page, a risk score over the block threshold, an item that has waited days.
   It was used in six places and defined in none — every one of them silently
   rendered as plain bold text. Caught by looking at the page; a test now
   asserts every badge class used is defined. */
.badge-warn { background: #fdece9; color: #9c2c1a; }

/* listing detail */
.detail { display: grid; grid-template-columns: 1fr 330px; gap: 34px; align-items: start;
  padding: 26px 0 60px; }
.gallery { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.gallery .main { aspect-ratio: 16/10; max-height: 420px; width: 100%;
  object-fit: cover; background: var(--surface); display: grid;
  place-items: center; color: var(--muted-2); }
.facts-row { display: flex; gap: 26px; padding: 16px 0; border-bottom: 1px solid var(--line);
  margin-bottom: 18px; flex-wrap: wrap; }
.fact b { display: block; font-size: 17px; }
.fact span { color: var(--muted); font-size: 13px; }
.aside { border: 1px solid var(--line); border-radius: var(--radius); padding: 18px;
  position: sticky; top: 78px; }
.aside .price { font-size: 25px; font-weight: 700; letter-spacing: -0.02em; }

/* tabs */
.tabs { display: flex; gap: 3px; border-bottom: 1px solid var(--line); margin: 22px 0 16px; }
.tabs button { border: 0; background: none; padding: 9px 13px; font: 600 14px var(--font);
  color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tabs button[aria-selected=true] { color: var(--accent); border-bottom-color: var(--accent); }
.tabpanel[hidden] { display: none; }

/* notices */
.notice { padding: 12px 14px; border-radius: 8px; background: var(--tint);
  color: var(--accent); font-size: 14px; margin-bottom: 16px; }
.notice-warn { background: #fdf3e3; color: #8a5a10; }
.empty { padding: 56px 20px; text-align: center; color: var(--muted); }

.muted { color: var(--muted); }
.small { font-size: 13px; }
.stack > * + * { margin-top: 14px; }
footer.site-foot { border-top: 1px solid var(--line); margin-top: 40px; padding: 26px 0;
  color: var(--muted); font-size: 13px; }

@media (max-width: 860px) {
  .detail { grid-template-columns: 1fr; }
  .aside { position: static; }
  .hero h1 { font-size: 27px; }
  .site nav { gap: 12px; }
}
`;

/**
 * Wraps a page body in the site shell.
 *
 * Everything about the `<head>` here is SEO plumbing, which analysis/02 calls
 * the moat against Realtor.ca — a canonical URL, a real description, and
 * Open Graph tags so a listing pasted into a group chat renders as a card.
 */
export function page(opts: PageOptions, body: Html): string {
  const title = opts.title ? `${opts.title} · Portage` : 'Portage';
  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
${opts.description ? `<meta name="description" content="${escape(opts.description)}">` : ''}
${opts.path ? `<link rel="canonical" href="${escape(opts.path)}">` : ''}
<meta property="og:site_name" content="Portage">
<meta property="og:title" content="${escape(opts.title || 'Portage')}">
${opts.description ? `<meta property="og:description" content="${escape(opts.description)}">` : ''}
<meta name="theme-color" content="#24528f">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&display=swap">
<style>${CSS}</style>
${opts.head ?? ''}
${opts.structuredData
    ? `<script type="application/ld+json">${opts.structuredData}</script>`
    : ''}
</head>
<body${opts.bodyClass ? ` class="${escape(opts.bodyClass)}"` : ''}>
${header(opts.viewer ?? null)}
${flash(opts)}
<main>${body}</main>
${footer()}
</body>
</html>`;
}

/** The flash strip. Absent when there is nothing to say. */
function flash(opts: PageOptions): Html {
  if (!opts.notice && !opts.error) return raw('');
  return html`
<div class="wrap" style="padding-top:16px">
  ${opts.error ? html`<p class="notice notice-warn" role="alert">${opts.error}</p>` : null}
  ${opts.notice ? html`<p class="notice" role="status">${opts.notice}</p>` : null}
</div>`;
}

function header(viewer: Viewer | null): Html {
  return html`
<header class="site"><div class="wrap">
  <a class="brand" href="/">Port<span>age</span></a>
  <nav>
    <a href="/search">Search</a>
    ${viewer ? html`<a href="/dashboard/listings">My listings</a>` : null}
    ${viewer ? html`<a href="/messages">Messages</a>` : null}
    ${viewer && (viewer.role === 'staff' || viewer.role === 'admin')
      ? html`<a href="/admin/queue">Moderation</a>` : null}
    ${viewer
      ? html`
        <a class="btn btn-sm" href="/dashboard/listings/new">Post a listing</a>
        ${/* A POST, not a link. Sign-out from a GET is something any <img>
              on any page could do to a visitor. */
          viewer.csrfToken
          ? html`<form method="post" action="/signout" style="display:inline">
                   ${csrfField(viewer)}
                   <button class="btn btn-sm" type="submit">Sign out</button>
                 </form>`
          : null}`
      : html`<a href="/signin">Sign in</a>
             <a class="btn btn-sm btn-primary" href="/signup">Create account</a>`}
  </nav>
</div></header>`;
}

function footer(): Html {
  return html`
<footer class="site-foot"><div class="wrap">
  Portage — owner-direct property in Regina, Saskatchewan. No commission, no listing fee.
  <br>Listings are posted by their owners. Never send money before viewing a property in person.
</div></footer>`;
}

/**
 * The hidden field that makes a form post survive the CSRF check.
 *
 * Every signed-in form needs exactly this. It throws rather than rendering
 * nothing when the token is missing, because the alternative is a form that
 * looks fine, submits, and is refused — with the cause three layers away.
 */
export function csrfField(viewer: Viewer): Html {
  if (!viewer.csrfToken) {
    throw new Error('csrfField: the viewer carries no CSRF token — see routes.ts viewerOf()');
  }
  return html`<input type="hidden" name="csrf" value="${viewer.csrfToken}">`;
}

/** `$1,500` — cents in, dollars out, no stray decimals on whole amounts. */
export function money(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString('en-CA', {
    minimumFractionDigits: dollars % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** `2 bed · 1 bath · 800 sq ft`, skipping whatever is absent. */
export function facts(l: {
  beds?: number | null; baths?: number | null; sqft?: number | null;
}): string {
  const parts: string[] = [];
  if (l.beds !== null && l.beds !== undefined) parts.push(`${l.beds} bed`);
  if (l.baths !== null && l.baths !== undefined) parts.push(`${l.baths} bath`);
  if (l.sqft !== null && l.sqft !== undefined) parts.push(`${l.sqft.toLocaleString('en-CA')} sq ft`);
  return parts.join(' · ');
}

/** Amenity keys are snake_case in the database and prose on the page. */
export function amenityLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export { raw };
