/**
 * Frontend tests.
 *
 * Almost all of these are about escaping, because that is the one thing the
 * web layer can get wrong in a way that hurts somebody. A listing title, a
 * description, an address and a message body are all written by members of
 * the public and all four end up on a page other people load while signed in.
 *
 * The assertions are written as attacks, the same way the search tests are.
 * The design claim under test is that XSS is structurally impossible here —
 * there is no way to build a page except through `html`, which escapes, and
 * the only bypass is `raw()`, which is greppable and has three callers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { html, raw, escape, safeUrl, jsonScript, classes, Html } from '../src/web/html.js';
import { page, money, facts, amenityLabel, csrfField } from '../src/web/layout.js';
import { FormFields, FormError, readForm, redirectTo, flashOf } from '../src/web/form.js';
import {
  CSRF_COOKIE, SESSION_COOKIE, createSessionMaterial, requiresCsrf,
} from '../src/lib/session.js';
import { homePage, searchPage, listingPage, signInPage } from '../src/web/pages.js';
import type { SearchResultCard } from '../src/modules/search/service.js';
import type { ListingView } from '../src/modules/listings/service.js';

// ── the escaping primitive ──────────────────────────────────────────────────

test('html escapes every interpolation by default', () => {
  const evil = '<script>alert(1)</script>';
  const out = html`<h1>${evil}</h1>`.value;
  assert.equal(out, '<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>');
  assert.ok(!out.includes('<script>'));
});

test('html escapes quotes, because attributes are the common case', () => {
  // `title="${x}"` appears more often than a bare text node, and escaping
  // only < and & leaves it wide open.
  const evil = '" onmouseover="alert(1)';
  const out = html`<a title="${evil}">x</a>`.value;
  assert.ok(!/onmouseover="alert/.test(out), out);
  assert.ok(out.includes('&quot;'));
});

test('html escapes single quotes too', () => {
  // Single-quoted attributes are legal HTML and a parser accepts them.
  const out = html`<a title='${"' onerror='alert(1)"}'>x</a>`.value;
  assert.ok(!/onerror='alert/.test(out), out);
});

test('escape handles the five characters and nothing else', () => {
  assert.equal(escape(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  // Not over-eager: ordinary punctuation in a Regina address must survive.
  assert.equal(escape('2100 Victoria Ave #3B — Regina, SK'), '2100 Victoria Ave #3B — Regina, SK');
});

test('nested html is not double-escaped', () => {
  // The composition property. Without it, a card inside a grid would render
  // its own markup as visible text.
  const inner = html`<b>${'<i>'}</b>`;
  const out = html`<div>${inner}</div>`.value;
  assert.equal(out, '<div><b>&lt;i&gt;</b></div>');
});

test('arrays render by joining, with each item escaped', () => {
  // So `${items.map(row)}` works without a .join('') that is easy to forget
  // and silently produces a comma-separated page.
  const out = html`<ul>${['<a>', '<b>'].map((s) => html`<li>${s}</li>`)}</ul>`.value;
  assert.equal(out, '<ul><li>&lt;a&gt;</li><li>&lt;b&gt;</li></ul>');
});

test('null, undefined and false render as nothing', () => {
  // An absent unit number should be absent, not the word "undefined".
  assert.equal(html`a${null}b${undefined}c${false}d`.value, 'abcd');
  // Zero and empty string are values, not absence — a studio has 0 bedrooms.
  assert.equal(html`${0}`.value, '0');
});

test('raw is the only bypass, and it is explicit', () => {
  assert.equal(html`${raw('<b>ok</b>')}`.value, '<b>ok</b>');
  assert.ok(raw('x') instanceof Html);
});

test('the codebase has few raw() callers, and each is markup we built', async () => {
  // The security argument depends on this staying enumerable. If this count
  // climbs, the claim "XSS is structurally impossible" needs re-examining
  // rather than restating.
  const { readFile } = await import('node:fs/promises');
  let total = 0;
  for (const f of ['layout.ts', 'pages.ts', 'html.ts']) {
    const src = await readFile(new URL(`../src/web/${f}`, import.meta.url).pathname, 'utf8');
    total += (src.match(/\braw\(/g) ?? []).length;
  }
  assert.ok(total <= 12, `raw() has ${total} call sites; each one is a place XSS could come from`);
});

// ── URLs ────────────────────────────────────────────────────────────────────

test('safeUrl refuses javascript: however it is dressed up', () => {
  // Escaping cannot help here: `javascript:alert(1)` contains no character
  // escape would touch, and it executes on click.
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
  ]) {
    assert.equal(safeUrl(bad), '#', `${bad} must not survive`);
  }
});

test('safeUrl allows same-origin paths and http(s), and blocks protocol-relative', () => {
  assert.equal(safeUrl('/listings/abc'), '/listings/abc');
  assert.equal(safeUrl('https://portage.ca/x'), 'https://portage.ca/x');
  // //evil.example is a protocol-relative URL that leaves the origin.
  assert.equal(safeUrl('//evil.example/x'), '#');
});

test('classes skips falsy names and escapes the rest', () => {
  assert.equal(classes('a', false, null, 'b').value, ' class="a b"');
  assert.equal(classes(false).value, '');
  assert.equal(classes('"><script>').value, ' class="&quot;&gt;&lt;script&gt;"');
});

// ── JSON in a script block ──────────────────────────────────────────────────

test('jsonScript cannot be closed early by its own content', () => {
  // A listing titled `</script><img onerror=...>` is exactly the attack, and
  // JSON.stringify alone does not escape `<`.
  const out = jsonScript({ name: '</script><img src=x onerror=alert(1)>' }).value;
  assert.ok(!out.includes('</script>'), out);
  assert.ok(!out.includes('<'), 'no literal < may survive into a script block');
  assert.deepEqual(JSON.parse(out), { name: '</script><img src=x onerror=alert(1)>' });
});

// ── the shell ───────────────────────────────────────────────────────────────

test('page escapes the title and description it is given', () => {
  const out = page({ title: '<script>t</script>', description: '"desc' }, html`x`);
  assert.ok(!out.includes('<title><script>'), out.slice(0, 400));
  assert.ok(out.includes('&lt;script&gt;t&lt;/script&gt;'));
  assert.ok(out.includes('content="&quot;desc"'));
});

test('page emits the SEO tags the business case depends on', () => {
  // analysis/02 puts SEO as the moat against Realtor.ca, so these are not
  // decoration: a canonical URL, a description, and og: tags for a link
  // pasted into a group chat.
  const out = page({ title: 'A home', description: 'Nice', path: '/listings/x' }, html`y`);
  assert.match(out, /<link rel="canonical" href="\/listings\/x">/);
  assert.match(out, /<meta name="description" content="Nice">/);
  assert.match(out, /<meta property="og:title" content="A home">/);
  assert.match(out, /<html lang="en-CA">/);
  assert.match(out, /<meta name="viewport"/);
});

test('page omits tags rather than emitting empty ones', () => {
  const out = page({ title: 'x' }, html`y`);
  assert.ok(!out.includes('name="description"'), 'an empty description is worse than none');
  assert.ok(!out.includes('rel="canonical"'));
});

// ── formatting ──────────────────────────────────────────────────────────────

test('money renders whole dollars without stray decimals', () => {
  assert.equal(money(150_000), '$1,500');
  assert.equal(money(42_900_000), '$429,000');
  assert.equal(money(150_050), '$1,500.50');
  assert.equal(money(0), '$0');
});

test('facts skips what is absent rather than printing null', () => {
  assert.equal(facts({ beds: 2, baths: 1, sqft: 820 }), '2 bed · 1 bath · 820 sq ft');
  assert.equal(facts({ beds: 0, baths: 1, sqft: null }), '0 bed · 1 bath', 'a studio has 0 beds');
  assert.equal(facts({}), '');
});

test('amenityLabel turns database keys into prose', () => {
  assert.equal(amenityLabel('heated_garage'), 'Heated garage');
  assert.equal(amenityLabel('block_heater_plug'), 'Block heater plug');
});

// ── whole pages, against hostile data ───────────────────────────────────────

const CARD: SearchResultCard = {
  id: 'l-1', mode: 'rent', priceCents: 150_000, propertyType: 'apartment',
  roomType: null, beds: 2, baths: 1, sqft: 820, amenities: [],
  title: 'Bright two bedroom', summary: null, publishedAt: new Date(),
  address: {
    addressLine: '2100 Victoria Ave', unit: null, city: 'Regina',
    province: 'SK', postalCode: null, lat: null, lng: null,
  },
  neighbourhoodId: null, photo: null,
};

const LISTING: ListingView = {
  id: 'l-1', mode: 'rent', status: 'live', priceCents: 150_000,
  propertyType: 'apartment', roomType: 'entire', beds: 2, baths: 1, sqft: 820,
  amenities: ['parking'], title: 'Bright two bedroom', description: 'A flat.',
  descriptionSource: 'human', descriptionAttested: false,
  publishedAt: new Date(), expiresAt: null, createdAt: new Date(),
  address: {
    addressLine: '2100 Victoria Ave', unit: null, city: 'Regina',
    province: 'SK', postalCode: null, lat: null, lng: null,
  },
  photos: [], isOwner: false,
};

const XSS = '<script>alert(1)</script>';

/** Every `<script>` in the output that we did not put there ourselves. */
function foreignScripts(markup: string): string[] {
  return (markup.match(/<script[^>]*>/g) ?? []).filter(
    (s) => !s.includes('application/ld+json') && s !== '<script>',
  );
}

test('a hostile listing renders as text on every page that shows it', () => {
  const hostile: ListingView = {
    ...LISTING,
    title: XSS,
    description: `</script><img src=x onerror=alert(2)>`,
    address: { ...LISTING.address, addressLine: '<h1>injected</h1>' },
  };
  const out = listingPage({ viewer: null, listing: hostile, origin: 'https://portage.ca' });

  assert.equal(foreignScripts(out).length, 0);
  assert.ok(!out.includes('<script>alert(1)</script>'));
  assert.ok(!/<img src=x onerror/.test(out));
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'it is still readable as text');
});

test('a hostile card renders as text in search and on the home page', () => {
  const hostile = {
    ...CARD,
    title: XSS,
    address: { ...CARD.address, addressLine: `"><img src=x onerror=alert(1)>` },
  };
  for (const out of [
    searchPage({ viewer: null, query: XSS, results: { results: [hostile], sort: 'relevance' } }),
    homePage({ viewer: null, recent: [hostile], liveCount: 1 }),
  ]) {
    assert.equal(foreignScripts(out).length, 0);
    assert.ok(!/<img src=x onerror/.test(out));
  }
});

test('a hostile search query cannot break out of the input it is echoed into', () => {
  // The query is reflected into value="..." on the results page, which is the
  // classic reflected-XSS shape.
  const out = searchPage({
    viewer: null,
    query: '"><script>alert(1)</script>',
    results: { results: [], sort: 'relevance' },
  });
  assert.equal(foreignScripts(out).length, 0);
  assert.match(out, /value="&quot;&gt;&lt;script&gt;/);
});

test('a hostile error message on the sign-in page is escaped', () => {
  const out = signInPage({ error: XSS, next: '"><b>x' });
  assert.equal(foreignScripts(out).length, 0);
  assert.ok(!out.includes('<b>x'));
});

test('the listing page states the anti-fraud warning', () => {
  // analysis/02: fraud is the reason "verified" beats "free" in rentals, and
  // the warning belongs next to the message box, not in a help page.
  const out = listingPage({ viewer: null, listing: LISTING, origin: 'https://x' });
  assert.match(out, /Never send money/i);
});

test('an owner sees management, not an enquiry form', () => {
  const out = listingPage({
    viewer: { userId: 'o', role: 'user' },
    listing: { ...LISTING, isOwner: true },
    origin: 'https://x',
  });
  assert.ok(!out.includes('Send enquiry'), 'messaging yourself is not a feature');
  assert.match(out, /Manage this listing/);
});

test('every tab panel is in the HTML, so a crawler sees the details', () => {
  // Progressive enhancement is load-bearing here: a listing whose details
  // only appear after a script runs is a listing Google indexes without them,
  // which defeats the reason the page is server-rendered at all.
  const out = listingPage({
    viewer: null,
    listing: { ...LISTING, amenities: ['heated_garage', 'dishwasher'] },
    origin: 'https://x',
  });
  assert.match(out, /Heated garage/);
  assert.match(out, /Dishwasher/);
  assert.match(out, /id="p-details"/);
});

test('structured data carries the facts, and never the description', () => {
  // The description is prose and may be AI-written; these are the facts a
  // search result renders, and they come from the row.
  const out = listingPage({ viewer: null, listing: LISTING, origin: 'https://portage.ca' });
  const block = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(out)![1]!;
  const data = JSON.parse(block) as Record<string, unknown>;
  assert.equal(data['numberOfBedrooms'], 2);
  assert.equal(data['url'], 'https://portage.ca/listings/l-1');
  assert.ok(!JSON.stringify(data).includes('A flat.'));
});

test('the search page explains a fallback rather than apologising for it', () => {
  // The results below are a real search either way, so this is a note, not a
  // failure — and it must not be shown when the AI DID read the query.
  const withFallback = searchPage({
    viewer: null, query: 'what is the weather',
    results: { results: [CARD], sort: 'relevance' }, fallback: 'not_confident',
  });
  assert.match(withFallback, /did not look like a property search/);

  const withReading = searchPage({
    viewer: null, query: 'two bed', results: { results: [CARD], sort: 'relevance' },
    reading: 'Two bedrooms.', fallback: 'not_confident',
  });
  assert.ok(!withReading.includes('did not look like'), 'a reading supersedes the fallback note');
  assert.match(withReading, /Read as: Two bedrooms\./);
});

test('staff see the moderation link and ordinary users do not', () => {
  const staff = homePage({ viewer: { userId: 'u', role: 'staff' }, recent: [], liveCount: 0 });
  assert.match(staff, /\/admin\/queue/);

  const user = homePage({ viewer: { userId: 'u', role: 'user' }, recent: [], liveCount: 0 });
  assert.ok(!user.includes('/admin/queue'), 'the admin surface is not advertised');

  const anon = homePage({ viewer: null, recent: [], liveCount: 0 });
  assert.ok(!anon.includes('/admin/queue'));
  assert.match(anon, /Sign in/);
});

// ── the design system cannot drift from the pages that use it ───────────────

test('every badge class a page uses is defined in the CSS', async () => {
  // This exists because `.badge-warn` was used in six places and defined in
  // none. Every one of them rendered as plain bold text — including "Off" on
  // the kill-switch page, which is the single state you most need to spot
  // during an incident. Nothing failed; it just quietly looked wrong.
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('../src/web/', import.meta.url).pathname;

  const layout = await readFile(`${dir}layout.ts`, 'utf8');
  const defined = new Set(
    [...layout.matchAll(/\.(badge-[a-z0-9-]+)\s*\{/g)].map((m) => m[1]!),
  );

  const used = new Set<string>();
  for (const f of ['pages.ts', 'pages-app.ts', 'pages-admin.ts', 'layout.ts']) {
    const src = await readFile(`${dir}${f}`, 'utf8');
    for (const m of src.matchAll(/['"`\s](badge-[a-z0-9-]+)['"`\s]/g)) used.add(m[1]!);
  }

  const missing = [...used].filter((c) => !defined.has(c));
  assert.deepEqual(missing, [], `badge classes used but never defined: ${missing.join(', ')}`);
  assert.ok(defined.size >= 4, 'sanity: the CSS should define several badge classes');
});

test('every chip and notice modifier a page uses is defined too', async () => {
  // Same failure mode as the badges, checked for the other two families that
  // carry meaning rather than decoration.
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('../src/web/', import.meta.url).pathname;
  const layout = await readFile(`${dir}layout.ts`, 'utf8');

  for (const family of ['chip', 'notice']) {
    const defined = new Set(
      [...layout.matchAll(new RegExp(`\\.(${family}-[a-z0-9-]+)\\s*\\{`, 'g'))]
        .map((m) => m[1]!),
    );
    const used = new Set<string>();
    for (const f of ['pages.ts', 'pages-app.ts', 'pages-admin.ts']) {
      const src = await readFile(`${dir}${f}`, 'utf8');
      for (const m of src.matchAll(new RegExp(`[\\s"'\`](${family}-[a-z0-9-]+)[\\s"'\`]`, 'g'))) {
        used.add(m[1]!);
      }
    }
    const missing = [...used].filter((c) => !defined.has(c));
    assert.deepEqual(missing, [], `${family} classes used but never defined: ${missing.join(', ')}`);
  }
});

test('no page nests a form inside another form', async () => {
  // Invalid HTML that browsers do not report: the inner <form> is dropped and
  // its buttons silently submit the OUTER one. On the thread page that meant
  // "Block this conversation" would have sent a reply instead — the opposite
  // of what someone clicking it wants, with no error anywhere.
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('../src/web/', import.meta.url).pathname;

  for (const f of ['pages.ts', 'pages-app.ts', 'pages-admin.ts']) {
    // Comments are stripped first. The comment explaining THIS bug mentions
    // a form inside a form in prose, and a scanner that counted it would
    // report the file it was added to — which is a fine way to spend twenty
    // minutes concluding the test is broken.
    const src = (await readFile(`${dir}${f}`, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // Walk the template text tracking form depth. Crude, and sufficient:
    // these files contain no computed tag names, so a textual scan sees
    // exactly what the browser will.
    let depth = 0;
    let maxDepth = 0;
    for (const m of src.matchAll(/<form\b|<\/form>/g)) {
      depth += m[0] === '</form>' ? -1 : 1;
      maxDepth = Math.max(maxDepth, depth);
    }
    assert.equal(depth, 0, `${f}: unbalanced <form> tags`);
    assert.equal(maxDepth, 1, `${f}: a <form> is nested inside another <form>`);
  }
});

// ── forms ───────────────────────────────────────────────────────────────────
//
// The claim under test is that accepting HTML form posts did NOT weaken CSRF.
// The existing defence is double-submit: a value in a cookie must equal a
// value the page sends back, and both must match a digest on the session row.
// It works because an attacker's site cannot READ our cookie — an argument
// that never mentioned headers. These assertions are the attacks that would
// succeed if a hidden field were somehow weaker than a header.

test('every signed-in form carries a CSRF field', async () => {
  // A form without one looks fine, submits, and is refused — with the cause
  // three layers away from the page that caused it.
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('../src/web/', import.meta.url).pathname;

  for (const f of ['pages.ts', 'pages-app.ts', 'pages-admin.ts', 'layout.ts']) {
    const src = (await readFile(`${dir}${f}`, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // Each <form> up to its closing tag must contain either csrfField(...) or
    // be one of the two anonymous posts, which have no session to protect.
    for (const m of src.matchAll(/<form\b[\s\S]*?<\/form>/g)) {
      const block = m[0];

      // GET forms change nothing, so they need no token — and the rule for
      // which methods do is `requiresCsrf`, reused rather than restated. The
      // search box is the case: a token on it would be noise in the URL.
      const method = /method="(\w+)"/.exec(block)?.[1] ?? 'get';
      if (!requiresCsrf(method)) continue;

      // Sign in and sign up carry no session to protect and no digest to
      // check against; the origin check covers them, as it does on the JSON
      // side.
      const anonymous = /action="\/(signin|signup)"/.test(block);

      assert.ok(
        anonymous || block.includes('csrfField('),
        `${f}: a state-changing form has no CSRF field:\n${block.slice(0, 160)}`,
      );
    }
  }
});

test('no form posts to the JSON API, which cannot accept it', async () => {
  // The API requires application/json and a CSRF header; a <form> can send
  // neither. A form pointed at /api/... renders perfectly and does nothing.
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('../src/web/', import.meta.url).pathname;
  for (const f of ['pages.ts', 'pages-app.ts', 'pages-admin.ts', 'layout.ts']) {
    const src = await readFile(`${dir}${f}`, 'utf8');
    assert.ok(!/action="\/api\//.test(src), `${f}: a form posts to the JSON API`);
  }
});

test('csrfField throws rather than rendering a form that cannot submit', () => {
  // Loud at render time beats a silent 403 in production.
  assert.throws(
    () => csrfField({ userId: 'u', role: 'user' }),
    /CSRF token/,
  );
  assert.match(
    csrfField({ userId: 'u', role: 'user', csrfToken: 'tok' }).value,
    /name="csrf" value="tok"/,
  );
});

test('the CSRF token is escaped into the field like any other value', () => {
  const out = csrfField({ userId: 'u', role: 'user', csrfToken: '"><script>x' }).value;
  assert.ok(!out.includes('<script>'));
  assert.match(out, /&quot;&gt;&lt;script&gt;/);
});

test('every page function forwards the flash to the shell', async () => {
  // A redirect whose message nothing displays is a form that appears to do
  // nothing, and the page that forgets is always the one whose failure
  // mattered. Checked structurally rather than page by page.
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('../src/web/', import.meta.url).pathname;
  for (const f of ['pages.ts', 'pages-app.ts', 'pages-admin.ts']) {
    const src = await readFile(`${dir}${f}`, 'utf8');
    const exported = [...src.matchAll(/export function (\w+Page)\(/g)].map((m) => m[1]!);
    const forwards = (src.match(/notice: (opts|o)\.notice/g) ?? []).length;
    assert.equal(
      forwards, exported.length,
      `${f}: ${exported.length} page functions but ${forwards} forward the flash`,
    );
  }
});

test('the shell renders a flash, and omits the strip when there is none', () => {
  const withNotice = page({ title: 'x', notice: 'Saved as a draft.' }, html`y`);
  assert.match(withNotice, /role="status"/);
  assert.match(withNotice, /Saved as a draft\./);

  const withError = page({ title: 'x', error: '<script>alert(1)</script>' }, html`y`);
  assert.match(withError, /role="alert"/);
  assert.ok(!withError.includes('<script>alert(1)</script>'), 'a flash is escaped like anything else');

  const plain = page({ title: 'x' }, html`y`);
  assert.ok(!plain.includes('role="status"'));
  assert.ok(!plain.includes('role="alert"'));
});

test('redirectTo is a 303 with no store, and carries the message in the query', () => {
  // 303 tells the browser to follow with GET, which is what stops a refresh
  // from resending the POST.
  const res = redirectTo('/dashboard/listings', { notice: 'Saved & filed' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const loc = res.headers.get('location')!;
  assert.match(loc, /^\/dashboard\/listings\?notice=/);
  // Encoded, so a message with & or = cannot invent another parameter.
  assert.ok(!loc.includes('Saved & filed'));
  assert.equal(new URL(loc, 'https://x').searchParams.get('notice'), 'Saved & filed');
});

test('flashOf caps what it reads back', () => {
  // The message is attacker-influenceable — anyone can craft a link with one —
  // so it is bounded here and escaped by the shell.
  const url = new URL(`https://x/?notice=${'a'.repeat(5000)}`);
  assert.equal(flashOf(url).notice!.length, 300);
  assert.equal(flashOf(new URL('https://x/')).notice, null);
});

// ── form field parsing ──────────────────────────────────────────────────────

test('FormFields.all keeps every checkbox, not just the first', () => {
  // A checkbox group posts the same name repeatedly. Taking only the first is
  // how "parking, dishwasher, balcony" quietly becomes "parking".
  const f = new FormFields(new URLSearchParams('amenities=parking&amenities=dishwasher&amenities=balcony'));
  assert.deepEqual(f.all('amenities'), ['parking', 'dishwasher', 'balcony']);
  assert.equal(f.get('amenities'), 'parking');
});

test('FormFields returns undefined rather than NaN for absent numbers', () => {
  // An empty optional field must not become a listing with NaN bedrooms.
  const f = new FormFields(new URLSearchParams('beds=&baths=1.5&sqft=820&junk=abc'));
  assert.equal(f.int('beds'), undefined);
  assert.equal(f.int('missing'), undefined);
  assert.equal(f.num('baths'), 1.5);
  assert.equal(f.int('sqft'), 820);
  assert.equal(f.int('junk'), undefined, 'unparseable is absent, not NaN');
});

test('FormFields treats an unchecked box as false', () => {
  // An unchecked checkbox posts nothing at all, which is what makes it false.
  const f = new FormFields(new URLSearchParams('a=on&b=true'));
  assert.equal(f.bool('a'), true);
  assert.equal(f.bool('b'), true);
  assert.equal(f.bool('missing'), false);
});

test('FormFields trims, so a stray space is not a value', () => {
  const f = new FormFields(new URLSearchParams('title=%20%20Bright%20flat%20%20&empty=%20%20'));
  assert.equal(f.get('title'), 'Bright flat');
  assert.equal(f.get('empty'), '');
});

// ── readForm: the check that actually refuses a forged post ─────────────────
//
// These exist because a mutation test caught a hole: deleting the CSRF
// verification from readForm entirely broke NOTHING. The tests above assert
// that the TEMPLATES carry a token, which is necessary and proves nothing
// about whether the server looks at it. This is the half that matters.

function formApp(session: {
  userId?: string; role?: 'user' | 'staff' | 'admin'; csrfHash: Buffer;
} | null) {
  return {
    cfg: { allowedOrigins: ['https://portage.ca'] },
    auth: {
      async resolveSession() {
        return session
          ? { userId: session.userId ?? 'u1', sessionId: 's1', csrfHash: session.csrfHash,
              role: session.role ?? 'user' }
          : null;
      },
    },
  } as never;
}

function formPost(body: string, opts: {
  origin?: string | null; cookie?: string; contentType?: string;
} = {}): Request {
  const headers: Record<string, string> = {
    'content-type': opts.contentType ?? 'application/x-www-form-urlencoded',
  };
  if (opts.origin !== null) headers['origin'] = opts.origin ?? 'https://portage.ca';
  if (opts.cookie) headers['cookie'] = opts.cookie;
  return new Request('https://portage.ca/messages/t1/reply', { method: 'POST', headers, body });
}

async function expectRefusal(fn: () => Promise<unknown>, status: number, note: string) {
  try {
    await fn();
    assert.fail(`${note}: expected ${status}, but the post was accepted`);
  } catch (err) {
    assert.ok(err instanceof FormError, `${note}: got ${String(err)}`);
    assert.equal((err as FormError).status, status, note);
  }
}

test('readForm accepts a post whose hidden field matches the cookie and the digest', async () => {
  const m = createSessionMaterial();
  const { viewer, fields } = await readForm(
    formPost(`csrf=${m.csrfToken}&body=hello`, {
      cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${m.csrfToken}`,
    }),
    formApp({ csrfHash: m.csrfHash }),
  );
  assert.equal(viewer?.userId, 'u1');
  assert.equal(fields.get('body'), 'hello');
});

test('readForm refuses a post with no CSRF field at all', async () => {
  // The forgery an attacker's page can actually mount: it can make the
  // browser send our cookies, but it cannot read them to fill in the field.
  const m = createSessionMaterial();
  await expectRefusal(
    () => readForm(
      formPost('body=hello', { cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${m.csrfToken}` }),
      formApp({ csrfHash: m.csrfHash }),
    ),
    403, 'missing CSRF field',
  );
});

test('readForm refuses a guessed CSRF value', async () => {
  const m = createSessionMaterial();
  await expectRefusal(
    () => readForm(
      formPost(`csrf=${createSessionMaterial().csrfToken}&body=x`, {
        cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${m.csrfToken}`,
      }),
      formApp({ csrfHash: m.csrfHash }),
    ),
    403, 'wrong CSRF value',
  );
});

test('readForm refuses a value that matches the cookie but not the session digest', async () => {
  // The subdomain-injection case: an attacker who can SET our cookie could
  // otherwise make both halves agree. The stored digest is what stops them.
  const attacker = createSessionMaterial();
  const real = createSessionMaterial();
  await expectRefusal(
    () => readForm(
      formPost(`csrf=${attacker.csrfToken}&body=x`, {
        cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${attacker.csrfToken}`,
      }),
      formApp({ csrfHash: real.csrfHash }),
    ),
    403, 'cookie and field agree but the session does not',
  );
});

test('readForm refuses a cross-site origin before reading anything', async () => {
  const m = createSessionMaterial();
  await expectRefusal(
    () => readForm(
      formPost(`csrf=${m.csrfToken}&body=x`, {
        origin: 'https://evil.example',
        cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${m.csrfToken}`,
      }),
      formApp({ csrfHash: m.csrfHash }),
    ),
    403, 'cross-site origin',
  );
});

test('readForm refuses a post with no Origin header', async () => {
  const m = createSessionMaterial();
  await expectRefusal(
    () => readForm(
      formPost(`csrf=${m.csrfToken}&body=x`, {
        origin: null,
        cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${m.csrfToken}`,
      }),
      formApp({ csrfHash: m.csrfHash }),
    ),
    403, 'missing origin',
  );
});

test('readForm refuses a content type it cannot parse', async () => {
  // A cross-origin form can only send three encodings; refusing everything
  // else keeps the surface to the one this file actually handles.
  const m = createSessionMaterial();
  await expectRefusal(
    () => readForm(
      formPost(`csrf=${m.csrfToken}`, {
        contentType: 'text/plain',
        cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${m.csrfToken}`,
      }),
      formApp({ csrfHash: m.csrfHash }),
    ),
    415, 'wrong content type',
  );
});

test('readForm refuses an anonymous post to a route that needs a session', async () => {
  await expectRefusal(
    () => readForm(formPost('body=x'), formApp(null)),
    401, 'no session',
  );
});

test('sign in and sign up skip the CSRF check, and only they may', async () => {
  // They carry no session to protect and no digest to check against. The
  // origin check above is what covers them, exactly as on the JSON side.
  const { viewer, fields } = await readForm(
    formPost('email=a@b.test&password=hunter2hunter2'),
    formApp(null),
    { requireAuth: false },
  );
  assert.equal(viewer, null);
  assert.equal(fields.get('email'), 'a@b.test');
});

test('a signed-in caller is still checked even on an anonymous-allowed route', async () => {
  // requireAuth:false must relax WHO may post, never whether a session that
  // is present gets its token verified.
  const m = createSessionMaterial();
  await expectRefusal(
    () => readForm(
      formPost('email=a@b.test', { cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${m.csrfToken}` }),
      formApp({ csrfHash: m.csrfHash }),
      { requireAuth: false },
    ),
    403, 'session present, no token',
  );
});

test('readForm caps the body it will read', async () => {
  const m = createSessionMaterial();
  await expectRefusal(
    () => readForm(
      formPost(`csrf=${m.csrfToken}&body=${'x'.repeat(200_000)}`, {
        cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${m.csrfToken}`,
      }),
      formApp({ csrfHash: m.csrfHash }),
    ),
    413, 'oversized body',
  );
});
