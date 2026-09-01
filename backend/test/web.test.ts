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
import { editListingPage } from '../src/web/pages-edit.js';
import { newListingPage } from '../src/web/pages-app.js';
import { contentSecurityPolicy, uploadOriginOf } from '../src/web/headers.js';
import { hasIcon } from '../src/web/icons.js';
import {
  AMENITIES, AMENITY_GROUPS, PROPERTY_TYPES, ROOM_TYPES, MAX_PHOTOS,
} from '../src/modules/listings/policy.js';
import type { SearchResultCard } from '../src/modules/search/service.js';
import type { ListingView } from '../src/modules/listings/service.js';

/**
 * Every page-template file, discovered rather than listed.
 *
 * The scanners below — CSRF fields, nested forms, undefined CSS classes, forms
 * pointed at the JSON API — are only worth anything if they see every file. A
 * hardcoded list silently exempts the next page someone adds, which is exactly
 * when a new form with no CSRF field would appear.
 */
async function pageFiles(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(WEB_DIR);
  const found = names.filter((n) => /^(pages.*|layout)\.ts$/.test(n)).sort();
  // Without this, a typo in the pattern turns every scanner below into a loop
  // over nothing that passes triumphantly.
  assert.ok(found.length >= 4, `expected several page files, found ${found.join(', ')}`);
  assert.ok(found.includes('layout.ts'), 'layout.ts should be scanned too');
  return found;
}

const WEB_DIR = new URL('../src/web/', import.meta.url).pathname;

async function readWeb(file: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(`${WEB_DIR}${file}`, 'utf8');
}

/** Source with comments removed, so prose about markup is not read as markup. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

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
  // Discovered, not listed: a hardcoded list would have missed pages-edit.ts,
  // which is the file that adds the most raw() calls in the codebase.
  const perFile: string[] = [];
  let total = 0;
  for (const f of ['html.ts', ...(await pageFiles())]) {
    const n = ((await readWeb(f)).match(/\braw\(/g) ?? []).length;
    total += n;
    if (n > 0) perFile.push(`${f}=${n}`);
  }
  assert.ok(
    total <= 16,
    `raw() has ${total} call sites (${perFile.join(', ')}); each is a place XSS could come from`,
  );
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

/** The same listing with every text field turned into an attack. */
const HOSTILE_LISTING: ListingView = {
  ...LISTING,
  title: XSS,
  description: '</script><img src=x onerror=alert(2)>\nand onmouseover=\'alert(4)\'',
  address: { ...LISTING.address, addressLine: '<h1>injected</h1> 99 Fake St' },
};

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
  const defined = new Set(
    [...(await readWeb('layout.ts')).matchAll(/\.(badge-[a-z0-9-]+)\s*\{/g)].map((m) => m[1]!),
  );

  const used = new Set<string>();
  for (const f of await pageFiles()) {
    const src = await readWeb(f);
    for (const m of src.matchAll(/['"`\s](badge-[a-z0-9-]+)['"`\s]/g)) used.add(m[1]!);
  }

  const missing = [...used].filter((c) => !defined.has(c));
  assert.deepEqual(missing, [], `badge classes used but never defined: ${missing.join(', ')}`);
  assert.ok(defined.size >= 4, 'sanity: the CSS should define several badge classes');
});

test('every chip and notice modifier a page uses is defined too', async () => {
  // Same failure mode as the badges, checked for the other two families that
  // carry meaning rather than decoration.
  const layout = await readWeb('layout.ts');
  const files = await pageFiles();

  for (const family of ['chip', 'notice']) {
    const defined = new Set(
      [...layout.matchAll(new RegExp(`\\.(${family}-[a-z0-9-]+)\\s*\\{`, 'g'))]
        .map((m) => m[1]!),
    );
    const used = new Set<string>();
    for (const f of files) {
      const src = await readWeb(f);
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
  for (const f of await pageFiles()) {
    // Comments are stripped first. The comment explaining THIS bug mentions
    // a form inside a form in prose, and a scanner that counted it would
    // report the file it was added to — which is a fine way to spend twenty
    // minutes concluding the test is broken.
    const src = code(await readWeb(f));

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
    // `<= 1`, not `=== 1`: a template file with no forms in it is fine, and
    // the rule under test is "never two deep" — not "always exactly one".
    assert.ok(maxDepth <= 1, `${f}: a <form> is nested inside another <form>`);
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
  for (const f of await pageFiles()) {
    const src = code(await readWeb(f));

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
  for (const f of await pageFiles()) {
    const src = await readWeb(f);
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
  for (const f of await pageFiles()) {
    if (f === 'layout.ts') continue;
    const src = await readWeb(f);
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

// ── the edit page and its uploader ──────────────────────────────────────────
//
// Photos are the one place the site needs JavaScript, so they are the one
// place a template test is not enough: the script is a string, it is not
// typechecked, and a wrong endpoint or a wrong body key fails silently in a
// browser nobody is watching. These assert the contract between that string
// and the JSON routes it calls.

const EDIT_LISTING: ListingView = {
  ...HOSTILE_LISTING,
  id: 'l-edit',
  title: 'Bright two bedroom in Cathedral',
  description: 'Two bedrooms in Cathedral, heat included.',
  isOwner: true,
  photos: [],
  actions: ['submit'],
};

function edit(over: Partial<Parameters<typeof editListingPage>[0]> = {}): string {
  return editListingPage({
    viewer: { userId: 'o', role: 'user', csrfToken: 'tok' },
    listing: EDIT_LISTING,
    amenityGroups: AMENITY_GROUPS,
    roomTypes: ROOM_TYPES,
    aiEnabled: false,
    uploadsConfigured: true,
    ...over,
  });
}

test('the edit page names both blockers before an owner presses submit', () => {
  // The dead end this page exists to remove: submit refuses, and the refusal
  // does not say which of the two requirements is missing.
  const out = edit({
    listing: {
      ...EDIT_LISTING,
      photos: [],
      descriptionSource: 'ai_generated',
      descriptionAttested: false,
    },
  });
  assert.match(out, /Add at least one photo/);
  assert.match(out, /confirm it is accurate/);
});

test('the checklist disappears once both blockers are cleared', () => {
  const out = edit({
    listing: {
      ...EDIT_LISTING,
      photos: [{ id: 'p1', storageKey: 'listings/x/p1', kind: 'photo',
                 mime: 'image/jpeg', bytes: 1000, position: 0 }],
      descriptionSource: 'human',
    },
  });
  assert.ok(!out.includes('Before this can be submitted'), out.slice(0, 400));
});

test('only an AI description asks to be confirmed', () => {
  // The attestation block is what satisfies listings_publish_guard. Showing it
  // for copy the owner typed themselves would train them to click through it.
  const human = edit({ listing: { ...EDIT_LISTING, descriptionSource: 'human' } });
  assert.ok(!human.includes('Confirm the description'));

  const ai = edit({
    listing: { ...EDIT_LISTING, descriptionSource: 'ai_generated', descriptionAttested: false },
  });
  assert.match(ai, /Confirm the description/);
  assert.match(ai, /action="\/dashboard\/listings\/l-edit\/attest"/);

  const attested = edit({
    listing: { ...EDIT_LISTING, descriptionSource: 'ai_generated', descriptionAttested: true },
  });
  assert.ok(!attested.includes('Confirm the description'));
});

test('the uploader is replaced by an explanation when storage is not configured', () => {
  // Rendering a file input with nowhere to send the bytes is worse than not
  // rendering one: it fails after the owner has chosen twenty photos.
  const off = edit({ uploadsConfigured: false });
  assert.ok(!off.includes('id="photo-input"'));
  assert.match(off, /Photo storage is not configured/);

  const on = edit({ uploadsConfigured: true });
  assert.match(on, /id="photo-input"/);
});

test('the uploader hides itself at the photo cap rather than failing at it', () => {
  const full = edit({
    listing: {
      ...EDIT_LISTING,
      photos: Array.from({ length: MAX_PHOTOS }, (_, i) => ({
        id: `p${i}`, storageKey: `listings/x/p${i}`, kind: 'photo',
        mime: 'image/jpeg', bytes: 1000, position: i,
      })),
    },
  });
  assert.ok(!full.includes('id="photo-input"'));
  assert.match(full, new RegExp(`maximum of ${MAX_PHOTOS} photos`));
});

test('the uploader posts to endpoints that exist, with the body keys they parse', () => {
  // A mutation test on this file is what this replaces: changing the endpoint
  // or a body key in the script breaks nothing that runs in CI, and the only
  // symptom is an upload that does not happen.
  const out = edit();

  // Step 1 — the ticket. Registered in index.ts as POST /api/listings/:id/photos.
  assert.match(out, /fetch\('\/api\/listings\/' \+ encodeURIComponent\(listingId\) \+ '\/photos'/);
  assert.match(out, /JSON\.stringify\(\{ mime: mime, bytes: blob\.size \}\)/);

  // Step 3 — completion. The route validates `completionToken`; the ticket
  // calls the same value `uploadToken`, and getting that mapping backwards is
  // a 400 the owner sees as "the upload could not be confirmed".
  assert.match(out, /fetch\('\/api\/uploads\/complete'/);
  assert.match(out, /completionToken: ticket\.uploadToken/);

  // Both calls need the CSRF header, which is what makes them different from
  // every other write on this page.
  assert.equal((out.match(/'x-portage-csrf': csrf\(\)/g) ?? []).length, 2);
});

test('the uploader reads the CSRF cookie by its real name', async () => {
  // A stale cookie name here is a 403 on every upload, and the page would look
  // completely fine.
  const out = edit();
  assert.ok(out.includes(CSRF_COOKIE), `the script should read ${CSRF_COOKIE}`);
});

test('the upload script interpolates nothing, which is what makes raw() safe', async () => {
  const src = await readWeb('pages-edit.ts');
  const script = /const UPLOAD_SCRIPT = `([\s\S]*?)`;/.exec(src)?.[1];
  assert.ok(script, 'UPLOAD_SCRIPT should be a template literal');
  // `${` inside a raw()'d string is an injection point by construction: the
  // value would land in a <script> block with no escaping between it and the
  // parser.
  assert.ok(!script!.includes('${'), 'UPLOAD_SCRIPT must not interpolate anything');
});

test('a hostile listing is still text on the edit page, in inputs and all', () => {
  // The page with the most inputs, and the only one that echoes owner text
  // back into `value=` attributes and into a <textarea>.
  const out = edit({ listing: { ...HOSTILE_LISTING, isOwner: true, photos: [] } });

  // Our own inline scripts are removed before the tag checks. They are static
  // strings this file wrote, they contain markup as JS text on purpose (the
  // uploader builds a tile), and the claim under test is about INTERPOLATED
  // values reaching markup — not about what our own code says.
  const markup = out.replace(/<script>[\s\S]*?<\/script>/g, '');

  // What matters is that no TAG got through. The characters `onerror=alert(2)`
  // survive as text and are meant to: with the surrounding < and > escaped
  // they are letters in a textarea, not an attribute. Asserting on the
  // substring instead would fail on correct output, which is how a test ends
  // up being weakened until it checks nothing.
  assert.equal(foreignScripts(out).length, 0);
  assert.ok(!markup.includes('<img'), 'no photos, so no img tag may exist');
  assert.ok(!markup.includes('<iframe'));
  assert.ok(!markup.includes('<h1>injected'));

  // And the same text IS present, escaped — otherwise this would pass by
  // rendering nothing at all.
  assert.ok(out.includes('&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;'), out.slice(0, 200));
  assert.match(out, /value="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
});

test('a refused draft shows the reasons and never the copy', () => {
  // The draft is withheld on purpose. Copy that claims a garage the property
  // does not have, shown with a warning attached, is copy that gets published:
  // the warning is the part people skip.
  const out = edit({
    draftProblems: [{ phrase: 'heated garage', explanation: 'Not listed on this property.' }],
    error: 'The draft was not used — it said things your listing does not support.',
  });
  assert.match(out, /heated garage/);
  assert.match(out, /Not listed on this property/);
  assert.match(out, /false advertising claim/);
});

// ── the CSP that lets the upload happen ─────────────────────────────────────

test('connect-src names the bucket, or the upload is blocked before it is sent', () => {
  // The bug this encodes: with no connect-src at all the policy falls back to
  // default-src 'self', the presigned PUT is refused by the browser, and the
  // only evidence is a console message on a stranger's phone.
  const withBucket = contentSecurityPolicy({ uploadOrigin: 'https://acct.r2.cloudflarestorage.com' });
  assert.match(withBucket, /connect-src 'self' https:\/\/acct\.r2\.cloudflarestorage\.com/);

  const without = contentSecurityPolicy();
  assert.match(without, /connect-src 'self'(;|$)/);
  assert.ok(!without.includes('cloudflarestorage'));
});

test('the policy still forbids the things it forbade before', () => {
  const csp = contentSecurityPolicy({ uploadOrigin: 'https://bucket.example' });
  for (const clause of [
    "default-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ]) {
    assert.ok(csp.includes(clause), `${clause} missing from: ${csp}`);
  }
});

test('uploadOriginOf keeps the origin and drops everything else', () => {
  // Only the origin goes in the header. A presigned URL carries a signature,
  // and a signature does not belong in a header that is logged and cached.
  assert.equal(uploadOriginOf('acct.r2.cloudflarestorage.com'), 'https://acct.r2.cloudflarestorage.com');
  assert.equal(uploadOriginOf('https://acct.r2.cloudflarestorage.com'), 'https://acct.r2.cloudflarestorage.com');
  assert.equal(uploadOriginOf(undefined), null);
  assert.equal(uploadOriginOf(''), null);
});

test('a bucket host cannot smuggle extra CSP directives', () => {
  // The endpoint is configuration, not user input — but a header built by
  // string concatenation from a config value is worth one assertion.
  const out = contentSecurityPolicy({ uploadOrigin: uploadOriginOf('evil.example/x; script-src *') });
  assert.ok(!out.includes('script-src *'), out);
});

// ── redirectTo carrying more than a flash ───────────────────────────────────

test('redirectTo merges extra query params instead of making a second ?', () => {
  // The bug this prevents: `redirectTo(`${path}?problem=x`, { error })` builds
  // `path?problem=x?error=...`, and the browser reads the second half as part
  // of the first value.
  const q = new URLSearchParams();
  q.append('problem', 'a|b');
  q.append('problem', 'c|d');
  const res = redirectTo('/dashboard/listings/x/edit', { query: q, error: 'no' });

  const loc = res.headers.get('location')!;
  assert.equal(loc.split('?').length, 2, `two query strings in one URL: ${loc}`);
  const params = new URL(loc, 'https://portage.ca').searchParams;
  assert.deepEqual(params.getAll('problem'), ['a|b', 'c|d']);
  assert.equal(params.get('error'), 'no');
});

test('room type is offered on a rental and absent on a sale', () => {
  // `roomTypeAllowed` refuses a room type on a sale, so a select that offers
  // one there is a field whose only outcomes are "blank" and "rejected".
  const rental = edit({ roomTypes: ROOM_TYPES });
  assert.match(rental, /name="roomType"/);
  assert.match(rental, /The whole place/, 'the keys should read as prose');

  const sale = edit({ listing: { ...EDIT_LISTING, mode: 'sale' }, roomTypes: [] });
  assert.ok(!sale.includes('name="roomType"'));
});

// ── icons ───────────────────────────────────────────────────────────────────

test('every icon a page references is defined in the sprite', () => {
  // Two silent failures, one test. A <use href="#i-typo"> renders NOTHING —
  // no error, no console message, no broken-image glyph, just a gap on one
  // tile out of forty-two. And a page that uses icons but forgets to emit the
  // sprite renders forty-two of those gaps.
  for (const [name, out] of [['edit', edit()], ['new listing', newListing()]] as const) {
    const defined = new Set([...out.matchAll(/<symbol id="i-([a-zA-Z]+)"/g)].map((m) => m[1]!));
    const used = new Set([...out.matchAll(/<use href="#i-([a-zA-Z]+)"/g)].map((m) => m[1]!));

    const missing = [...used].filter((n) => !defined.has(n));
    assert.deepEqual(missing, [], `${name}: icons used but not defined: ${missing.join(', ')}`);
    assert.ok(used.size >= 10, `${name}: expected many icons, saw ${used.size}`);
  }
});

test('the new listing page offers the same picker as the edit page', () => {
  // One component, not two. The failure this prevents is quiet and slow: the
  // two forms drift, and an amenity added to one is missing from the other.
  const out = newListing();
  for (const a of AMENITIES) {
    assert.ok(out.includes(`name="amenities" value="${a}"`), `${a} should be offered`);
  }
  assert.equal((out.match(/type="checkbox" name="amenities"/g) ?? []).length, AMENITIES.length);
  assert.match(out, /data-amenities/);
});

test('a new listing starts with nothing ticked', () => {
  // A pre-ticked amenity on a brand new listing is a claim the owner never
  // made, on a form most people will submit without reading every tile.
  //
  // Matched as an ATTRIBUTE on an amenity input, not as the word: the page
  // also contains `input:checked` in the stylesheet, `b.checked` in the
  // script, and "Descriptions are checked against this list" in the prose. A
  // bare substring search finds all three and proves nothing.
  const out = newListing();
  const ticked = [...out.matchAll(/name="amenities" value="(\w+)"\s*\n?\s*checked/g)];
  assert.deepEqual(ticked.map((m) => m[1]), []);
  assert.match(out, /data-n="0"/, 'and the count says so');
});

function newListing(): string {
  return newListingPage({
    viewer: { userId: 'o', role: 'user', csrfToken: 'tok' },
    propertyTypes: PROPERTY_TYPES,
    amenityGroups: AMENITY_GROUPS,
    aiEnabled: true,
  });
}

test('the sprite is emitted once, not once per icon', () => {
  // <use> is the point: forty-two inline copies of the same path would be
  // most of the page weight.
  const out = edit();
  assert.equal((out.match(/<symbol id="i-car"/g) ?? []).length, 1);
});

test('every amenity group icon exists, and every amenity is in exactly one group', () => {
  // Both failures are invisible at a glance. A bad icon name renders an empty
  // box; an amenity left out of the groups simply cannot be chosen, and the
  // only symptom is that nobody ever ticks it.
  const seen = new Map<string, number>();
  for (const g of AMENITY_GROUPS) {
    for (const item of g.items) {
      assert.ok(hasIcon(item.icon), `${item.key}: no icon named ${item.icon}`);
      seen.set(item.key, (seen.get(item.key) ?? 0) + 1);
    }
  }

  const missing = AMENITIES.filter((a) => !seen.has(a));
  assert.deepEqual(missing, [], `amenities with no group, so unpickable: ${missing.join(', ')}`);

  const twice = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  assert.deepEqual(twice, [], `amenities in more than one group: ${twice.join(', ')}`);

  const unknown = [...seen.keys()].filter((k) => !AMENITIES.includes(k as never));
  assert.deepEqual(unknown, [], `groups name amenities the allowlist rejects: ${unknown.join(', ')}`);
});

// ── the amenity picker ──────────────────────────────────────────────────────

test('the picker posts what a plain checkbox list posted', () => {
  // The whole design rests on this. The tiles are styling over real
  // checkboxes, so the form data is unchanged and nothing about submitting
  // depends on a script having run.
  const out = edit({
    listing: { ...EDIT_LISTING, amenities: ['parking', 'heated_garage'] },
  });

  for (const a of AMENITIES) {
    assert.ok(
      out.includes(`name="amenities" value="${a}"`),
      `${a} should be offered as a checkbox`,
    );
  }
  assert.equal((out.match(/type="checkbox" name="amenities"/g) ?? []).length, AMENITIES.length);
});

test('the picker checks exactly the amenities the listing has', () => {
  const out = edit({ listing: { ...EDIT_LISTING, amenities: ['parking', 'heated_garage'] } });
  const checked = [...out.matchAll(/name="amenities" value="(\w+)"\s*\n?\s*checked/g)]
    .map((m) => m[1]!);
  assert.deepEqual(checked.sort(), ['heated_garage', 'parking']);
});

test('toggling needs no script: no inline handler appears on a tile', () => {
  // `input:checked + .amen-tile` does the styling. An onclick here would mean
  // the picker silently stops working when the script fails.
  const out = edit();
  const picker = out.slice(out.indexOf('data-amenities'), out.indexOf('</fieldset>'));
  assert.ok(!/\son[a-z]+=/.test(picker), 'a tile carries an inline event handler');
});

test('the checkbox is off-screen, not display:none, so it stays focusable', () => {
  // display:none removes an element from the tab order. A checkbox that
  // cannot be focused cannot be reached or announced, which would make the
  // whole picker unusable from a keyboard or a screen reader.
  const css = page({ title: 'x' }, html`y`);
  assert.match(css, /\.amen input \{[^}]*position: absolute/);
  assert.ok(!/\.amen input \{[^}]*display: none/.test(css));
});

test('the amenity filter box is hidden until the script reveals it', () => {
  // A search box that filters nothing is worse than no search box.
  const out = edit();
  assert.match(out, /class="amen-find" data-find hidden/);
});

// ── the photo controls ──────────────────────────────────────────────────────

test('every photo carries ordering controls that are plain form posts', () => {
  const out = edit({ listing: { ...EDIT_LISTING, photos: [shot('a', 0), shot('b', 1)] } });
  // Two moves per photo, plus a cover button on every photo but the first.
  assert.equal((out.match(/\/photos\/[ab]\/move"/g) ?? []).length, 5);
  assert.equal((out.match(/\/photos\/[ab]\/remove"/g) ?? []).length, 2);
  assert.ok(!out.includes('draggable'), 'drag does not fire on touch; this page uses buttons');
});

test('the first photo is the cover, and cannot be moved earlier or re-covered', () => {
  const [first, second] = tiles(edit({
    listing: { ...EDIT_LISTING, photos: [shot('a', 0), shot('b', 1)] },
  }));

  assert.match(first!, /shot-tag/, 'the cover should be labelled');
  assert.match(first!, /is-cover/);
  assert.match(first!, /disabled/, 'the cover cannot move earlier');
  assert.ok(!first!.includes('value="cover"'), 'the cover cannot be made the cover');

  assert.ok(!second!.includes('shot-tag'), 'only one photo is the cover');
  assert.match(second!, /value="cover"/, 'any other photo can become it');
});

test('the first cannot move earlier and the last cannot move later', () => {
  // Counted inside the tiles, not across the page: `disabled` also appears in
  // the stylesheet and in the uploader script, and a whole-document count
  // would pass whatever the buttons did.
  const [first, second] = tiles(edit({
    listing: { ...EDIT_LISTING, photos: [shot('a', 0), shot('b', 1)] },
  }));
  assert.equal((first!.match(/disabled/g) ?? []).length, 1);
  assert.equal((second!.match(/disabled/g) ?? []).length, 1);

  // The middle one of three has both moves available.
  const three = tiles(edit({
    listing: { ...EDIT_LISTING, photos: [shot('a', 0), shot('b', 1), shot('c', 2)] },
  }));
  assert.equal((three[1]!.match(/disabled/g) ?? []).length, 0);
});

/**
 * The photo tiles, one string each.
 *
 * Split on the complete opening tag, not the `<div class="shot` prefix — that
 * prefix also matches `<div class="shot-bar">`, which cuts every tile in half
 * at exactly the point where its buttons start, and leaves the assertions
 * below inspecting a picture and nothing else.
 */
function tiles(out: string): string[] {
  const grid = out.slice(out.indexOf('data-shots'), out.indexOf('id="uploader"'));
  // A lookahead, so the opening tag stays at the head of each tile — the
  // `is-cover` class lives in that tag, and a plain split would eat it.
  return grid
    .split(/(?=<div class="shot(?: is-cover)?">)/)
    .filter((t) => t.startsWith('<div class="shot'));
}

test('an icon-only control carries a label, since there is no text to read', () => {
  const out = edit({ listing: { ...EDIT_LISTING, photos: [shot('a', 0), shot('b', 1)] } });
  const buttons = [...out.matchAll(/<button class="shot-btn[^>]*>/g)].map((m) => m[0]);
  assert.ok(buttons.length >= 6, `expected several icon buttons, saw ${buttons.length}`);
  for (const btn of buttons) assert.match(btn, /aria-label="/);
  // And every icon is hidden from the reader, or a labelled button would be
  // announced twice — once for the label and once for the graphic.
  const icons = [...out.matchAll(/<svg class="ico[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.ok(icons.length >= 20, `expected many icons, saw ${icons.length}`);
  for (const i of icons) assert.match(i, /aria-hidden="true"/);
});

function shot(id: string, position: number) {
  return { id, storageKey: `listings/x/${id}`, kind: 'photo',
           mime: 'image/jpeg', bytes: 1000, position };
}
