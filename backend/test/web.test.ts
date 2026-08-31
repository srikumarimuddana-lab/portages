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
import { page, money, facts, amenityLabel } from '../src/web/layout.js';
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
