/**
 * Renders the pages to HTML files so they can be looked at.
 *
 * `pg` cannot be installed in the environment this was built in, so the
 * server cannot open a real connection and the pages cannot be browsed the
 * ordinary way. The templates are pure functions of their data, though, so
 * they can be rendered against representative rows and inspected — which is
 * what this does.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. It proves the markup, the CSS, the
 * layout at both widths, the escaping and the structured data — everything
 * the frontend actually owns. It does not exercise the service or database
 * round trip; that is what the SQL contracts and the 600-odd unit tests are
 * for, and re-proving it here through a fake would prove nothing.
 *
 *   node --experimental-strip-types scripts/render-preview.ts [outDir]
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { homePage, searchPage, listingPage, signInPage } from '../src/web/pages.js';
import {
  signUpPage, ownerListingsPage, newListingPage, inboxPage, threadPage,
} from '../src/web/pages-app.js';
import {
  queuePage, listingReviewPage, messageReviewPage, flagsPage,
} from '../src/web/pages-admin.js';
import { editListingPage } from '../src/web/pages-edit.js';
import {
  verifyEmailPage, forgotPasswordPage, resetPasswordPage,
} from '../src/web/pages-auth.js';
import { reportListingPage } from '../src/web/pages-report.js';
import { documentsPage } from '../src/web/pages-documents.js';
import { searchFilters, activeFilters } from '../src/web/pages-parts.js';
import { savedSearchesPage } from '../src/web/pages-saved.js';
import { ALERT_FREQUENCIES } from '../src/modules/search/saved.js';
import {
  filterValuesFrom, activeCount, chipsFor, clearHref, hiddenFields,
} from '../src/web/search-query.js';
import { auditPage } from '../src/web/pages-admin.js';
import { DOCUMENT_KINDS, MAX_DOCUMENT_BYTES } from '../src/modules/documents/policy.js';
import { AUDIT_ACTIONS } from '../src/modules/audit/service.js';
import { REPORT_KINDS } from '../src/modules/trust/reports.js';
import {
  AMENITIES, AMENITY_GROUPS, PROPERTY_TYPES, ROOM_TYPES,
} from '../src/modules/listings/policy.js';
import { FLAG_KEYS, FLAGS, defaultStateOf } from '../src/modules/flags/registry.js';
import type { SearchResultCard } from '../src/modules/search/service.js';
import type { ListingView } from '../src/modules/listings/service.js';

const OUT = process.argv[2] ?? '/tmp/portage-preview';

/** Regina addresses and prices, so the layout is judged at realistic lengths. */
const CARDS: SearchResultCard[] = [
  card('2100 Victoria Ave', 'Bright two bedroom in Cathedral', 150_000, 2, 1, 820, 'rent'),
  card('1845 Rae St', 'Character home near the park', 189_500, 3, 2, 1_340, 'rent'),
  card('318 Angus Cres', 'Renovated bungalow, Lakeview', 42_900_000, 3, 2, 1_180, 'sale'),
  card('5520 Gordon Rd', 'Modern townhouse with heated garage', 225_000, 3, 3, 1_520, 'rent'),
  card('2340 Smith St', 'Studio above the shops', 89_000, 0, 1, 410, 'rent'),
  card('47 Sunset Dr', 'Family home with a fenced yard', 38_500_000, 4, 3, 1_960, 'sale'),
  card('1120 8th Ave', 'One bedroom, utilities included', 112_500, 1, 1, 560, 'rent'),
  card('919 Retallack St', 'Upper suite, cats welcome', 132_000, 2, 1, 700, 'rent'),
];

function card(
  addressLine: string, title: string, priceCents: number,
  beds: number, baths: number, sqft: number, mode: string,
): SearchResultCard {
  return {
    id: `id-${addressLine.replace(/\W+/g, '-').toLowerCase()}`,
    mode, priceCents, propertyType: 'apartment', roomType: null,
    beds, baths, sqft, amenities: ['parking'], title,
    summary: null, publishedAt: new Date('2026-08-20T12:00:00Z'),
    address: {
      addressLine, unit: null, city: 'Regina', province: 'SK',
      postalCode: 'S4P 0N7', lat: null, lng: null,
    },
    neighbourhoodId: null,
    photo: null,
  };
}

const LISTING: ListingView = {
  id: 'bbbbbbbb-1111-4111-8111-111111111111',
  mode: 'rent', status: 'live', priceCents: 150_000,
  propertyType: 'apartment', roomType: 'entire',
  beds: 2, baths: 1, sqft: 820,
  amenities: [
    'parking', 'heated_garage', 'block_heater_plug', 'in_suite_laundry',
    'dishwasher', 'balcony', 'cats_allowed', 'heat_included',
  ],
  title: 'Bright two bedroom in Cathedral',
  description:
    'A two bedroom apartment in the Cathedral area of Regina, available at $1,500 '
    + 'per month with heat included.\n\n'
    + 'There is in-suite laundry and a dishwasher, a balcony off the living room, '
    + 'and a heated garage with a block heater plug. Around 820 square feet with '
    + 'one bathroom. Cats are welcome.',
  descriptionSource: 'human',
  descriptionAttested: false,
  publishedAt: new Date('2026-08-24T12:00:00Z'),
  expiresAt: null,
  createdAt: new Date('2026-08-20T12:00:00Z'),
  address: {
    addressLine: '2100 Victoria Ave', unit: '3B', city: 'Regina',
    province: 'SK', postalCode: 'S4P 0N7', lat: null, lng: null,
  },
  photos: [],
  isOwner: false,
};

/**
 * A listing whose every text field is an attack.
 *
 * Rendered alongside the real pages so the escaping is checked by looking at
 * it, not only by a unit test: if any of this executes or breaks the layout,
 * it is visible on the page rather than buried in an assertion.
 */
const HOSTILE: ListingView = {
  ...LISTING,
  id: 'hostile',
  title: '<script>alert(1)</script> "quoted" & <b>bold</b>',
  description:
    '</script><img src=x onerror=alert(2)>\n'
    + 'Second line with <iframe src="javascript:alert(3)"></iframe> and an '
    + "onmouseover='alert(4)' attribute break.",
  address: { ...LISTING.address, addressLine: '<h1>injected</h1> 99 Fake St' },
};

const CSRF = 'preview-csrf-token';
const STAFF = { userId: 's', role: 'staff' as const, csrfToken: CSRF };
const ADMIN = { userId: 'a', role: 'admin' as const, csrfToken: CSRF };
const OWNER = { userId: 'o', role: 'user' as const, csrfToken: CSRF };

const AT = new Date('2026-08-31T14:20:00Z');

const PAGES: Array<[string, string]> = [
  ['home', homePage({ viewer: null, recent: CARDS, liveCount: 128 })],
  ['search', searchPage({
    viewer: { userId: 'u1', role: 'user', csrfToken: CSRF },
    query: 'two bed under $1500 with parking',
    results: { results: CARDS.slice(0, 6), sort: 'relevance' },
    reading: 'Two bedrooms, up to $1,500 a month, with parking.',
  })],
  ['search-filtered', (() => {
    const params = new URLSearchParams(
      'q=cathedral&mode=rent&minPrice=1000&maxPrice=2000&minBeds=2&amenities=parking'
      + '&amenities=heated_garage&propertyTypes=apartment',
    );
    const values = filterValuesFrom(params);
    return searchPage({
      viewer: { userId: 'u1', role: 'user', csrfToken: CSRF },
      query: 'cathedral',
      results: { results: CARDS.slice(0, 4), sort: 'price_asc' },
      sort: 'price_asc',
      hidden: hiddenFields(params),
      filters: searchFilters({
        values, propertyTypes: PROPERTY_TYPES, amenityGroups: AMENITY_GROUPS,
        sorts: ['newest', 'price_asc', 'price_desc', 'relevance'],
        activeCount: activeCount(values), clearHref: clearHref(values),
      }),
      chips: activeFilters({ chips: chipsFor(params, values) }),
    });
  })()],
  ['search-fallback', searchPage({
    viewer: null,
    query: 'what is the weather',
    results: { results: CARDS.slice(0, 3), sort: 'relevance' },
    fallback: 'not_confident',
  })],
  ['search-empty', searchPage({
    viewer: null, query: 'castle with a moat',
    results: { results: [], sort: 'relevance' },
  })],
  ['listing', listingPage({
    viewer: { userId: 'u1', role: 'user', csrfToken: CSRF },
    listing: LISTING, origin: 'https://portage.ca',
  })],
  ['listing-anon', listingPage({
    viewer: null, listing: LISTING, origin: 'https://portage.ca',
  })],
  ['listing-flash', listingPage({
    viewer: { userId: 'u1', role: 'user', csrfToken: CSRF },
    listing: LISTING, origin: 'https://portage.ca',
    notice: 'Sent. You will get an email when they reply.',
  })],
  ['listing-owner', listingPage({
    viewer: { userId: 'owner', role: 'user', csrfToken: CSRF },
    listing: { ...LISTING, isOwner: true },
    origin: 'https://portage.ca',
  })],
  ['listing-hostile', listingPage({
    viewer: null, listing: HOSTILE, origin: 'https://portage.ca',
  })],
  ['signin', signInPage({})],
  ['signin-oauth', signInPage({ providers: ['google', 'facebook'] })],
  ['verify-email', verifyEmailPage({
    viewer: OWNER, email: 'owner@example.test', verified: false, sent: false,
  })],
  ['verify-email-done', verifyEmailPage({
    viewer: OWNER, email: 'owner@example.test', verified: true, sent: false,
  })],
  ['forgot-password', forgotPasswordPage({})],
  ['reset-password', resetPasswordPage({
    email: 'owner@example.test',
    notice: 'If that address is registered, a code is on its way. It expires in 10 minutes.',
  })],
  ['report-listing', reportListingPage({
    viewer: OWNER, kinds: REPORT_KINDS, from: '/listings/l1',
    listing: {
      id: 'l1', title: 'Bright two bedroom in Cathedral', priceCents: 150_000,
      mode: 'rent', addressLine: '2100 Victoria Ave', city: 'Regina',
    },
  })],
  ['signin-error', signInPage({ error: 'That email and password did not match.' })],
  ['signup', signUpPage({})],

  ['owner-listings', ownerListingsPage({
    viewer: OWNER,
    listings: [
      { ...LISTING, id: 'a', status: 'live', actions: ['pause', 'close'] },
      {
        ...LISTING, id: 'b', status: 'pending_review', title: 'Upper suite on Retallack',
        actions: [], address: { ...LISTING.address, addressLine: '919 Retallack St' },
      },
      {
        ...LISTING, id: 'c', status: 'draft', title: 'Studio above the shops',
        priceCents: 89_000, beds: 0, actions: ['submit'],
        descriptionSource: 'ai', descriptionAttested: false,
        address: { ...LISTING.address, addressLine: '2340 Smith St' },
      },
    ],
  })],
  ['owner-listings-empty', ownerListingsPage({ viewer: OWNER, listings: [] })],
  ['listing-new', newListingPage({
    viewer: OWNER, propertyTypes: PROPERTY_TYPES, amenityGroups: AMENITY_GROUPS,
    aiEnabled: true,
  })],

  // The draft an owner actually lands on: no photos, an unattested AI
  // description, and both blockers still open. This is the state the flow used
  // to dead-end in, so it is the one worth looking at.
  ['listing-edit-draft', editListingPage({
    viewer: OWNER,
    listing: {
      ...LISTING, id: 'draft-1', status: 'draft', isOwner: true,
      descriptionSource: 'ai_generated', descriptionAttested: false,
      photos: [], actions: ['submit'],
    },
    amenityGroups: AMENITY_GROUPS, roomTypes: ROOM_TYPES,
    aiEnabled: true, uploadsConfigured: true,
  })],
  ['listing-edit', editListingPage({
    viewer: OWNER,
    listing: {
      ...LISTING, id: 'live-1', isOwner: true, actions: ['pause', 'close'],
      photos: [
        photo('a', 0), photo('b', 1), photo('c', 2), photo('d', 3),
      ],
    },
    amenityGroups: AMENITY_GROUPS, roomTypes: ROOM_TYPES,
    aiEnabled: false, uploadsConfigured: true,
    notice: 'Saved.',
  })],
  // A refused draft. The copy is NOT shown — only what was wrong with it.
  ['listing-edit-refused', editListingPage({
    viewer: OWNER,
    listing: {
      ...LISTING, id: 'draft-2', status: 'draft', isOwner: true,
      description: null, descriptionSource: 'human', photos: [], actions: ['submit'],
    },
    amenityGroups: AMENITY_GROUPS, roomTypes: ROOM_TYPES,
    aiEnabled: true, uploadsConfigured: true,
    error: 'The draft was not used — it said things your listing does not support.',
    draftProblems: [
      { phrase: 'EV charger',
        explanation: 'The draft mentioned ev charger, which is not listed on this '
          + 'property. Add the amenity if the property has it, then try again.' },
      { phrase: 'sunny south-facing windows',
        explanation: 'The draft made a claim about orientation that Portage has no way '
          + 'to verify. Descriptions can only state facts from the listing itself.' },
    ],
  })],
  // Every field hostile, on the page that has the most inputs.
  ['listing-edit-hostile', editListingPage({
    viewer: OWNER,
    listing: { ...HOSTILE, isOwner: true, photos: [photo('x', 0)], actions: ['submit'] },
    amenityGroups: AMENITY_GROUPS, roomTypes: ROOM_TYPES,
    aiEnabled: true, uploadsConfigured: true,
  })],

  ['inbox', inboxPage({
    viewer: OWNER,
    threads: [
      thread('t1', 'Bright two bedroom in Cathedral', 2, 'owner', 'Is this still available?'),
      thread('t2', 'Upper suite on Retallack', 0, 'inquirer', 'Saturday at two works.'),
      { ...thread('t3', 'Studio above the shops', 0, 'owner', null), status: 'blocked' as const,
        blockedByMe: true },
    ],
  })],
  ['inbox-empty', inboxPage({ viewer: OWNER, threads: [] })],
  ['thread', threadPage({
    viewer: OWNER,
    thread: {
      ...thread('t1', 'Bright two bedroom in Cathedral', 0, 'owner', null),
      messages: [
        msg(false, 'Hi — is this still available? I would like to arrange a viewing.', false),
        msg(true, 'It is. Are you free Saturday afternoon?', false),
        msg(false, 'I am currently abroad but can courier the keys once you e-transfer the deposit.', true),
      ],
    },
  })],

  ['saved-searches', savedSearchesPage({
    viewer: OWNER, frequencies: ALERT_FREQUENCIES, alertsAvailable: true,
    searches: [
      { id: 's1', name: '2+ bed rentals under $1,500', href: '/search?mode=rent&minBeds=2',
        summary: ['To rent', 'Up to $1,500', '2+ bed', 'parking'],
        frequency: 'daily', alertEnabled: true, lastRunAt: AT },
      { id: 's2', name: 'Cathedral “character home”', href: '/search?q=cathedral',
        summary: ['To buy', 'heated garage'],
        frequency: 'weekly', alertEnabled: false, lastRunAt: null },
    ],
  })],
  ['saved-searches-empty', savedSearchesPage({
    viewer: OWNER, frequencies: ALERT_FREQUENCIES, alertsAvailable: true, searches: [],
  })],
  ['documents', documentsPage({
    viewer: OWNER, kinds: DOCUMENT_KINDS, maxBytes: MAX_DOCUMENT_BYTES,
    uploadsConfigured: true, now: AT,
    documents: [
      { id: 'd1', title: 'Tenancy agreement — 2100 Victoria Ave', kind: 'agreement',
        mime: 'application/pdf', bytes: 412_000, createdAt: AT, isOwner: true,
        retentionUntil: new Date(AT.getTime() + 700 * 86_400_000) },
      { id: 'd2', title: 'Move-in inspection photos', kind: 'inspection',
        mime: 'image/jpeg', bytes: 2_600_000, createdAt: AT, isOwner: true,
        retentionUntil: new Date(AT.getTime() + 21 * 86_400_000) },
      { id: 'd3', title: 'Rent receipt, August', kind: 'receipt',
        mime: 'application/pdf', bytes: 88_000, createdAt: AT, isOwner: true,
        retentionUntil: new Date(AT.getTime() + 400 * 86_400_000) },
    ],
  })],
  ['documents-empty', documentsPage({
    viewer: OWNER, kinds: DOCUMENT_KINDS, maxBytes: MAX_DOCUMENT_BYTES,
    uploadsConfigured: true, documents: [], now: AT,
  })],
  ['admin-audit', auditPage({
    viewer: ADMIN, actions: AUDIT_ACTIONS, action: null, nextBefore: '900',
    entries: [
      { id: '904', actorId: 'a', actorRole: 'admin', action: 'flag.set',
        subject: 'flag', subjectId: 'notify.email', at: AT,
        before: { enabled: true }, after: { enabled: false, note: 'SES bounce spike' } },
      { id: '903', actorId: 's', actorRole: 'staff', action: 'listing.reject',
        subject: 'listing', subjectId: 'bbbbbbbb-1111-4111-8111-111111111111', at: AT,
        before: null, after: { reason: 'Photos are of a different property.' } },
      { id: '902', actorId: 's', actorRole: 'staff', action: 'message.release',
        subject: 'message', subjectId: 'cccccccc-1111-4111-8111-111111111111', at: AT,
        before: null, after: null },
    ],
  })],
  ['admin-queue', queuePage({
    viewer: STAFF, state: 'open',
    stats: { open: 4, openListings: 2, openMessages: 2, oldestWaitingSec: 4 * 86400,
             blockedLast7d: 11, releasedLast7d: 3 },
    items: [
      queueItem('message', 130, 'Message from sender@example.test', 'block · Bright two bedroom',
                6 * 3600, [['money_request', 130], ['absent_landlord_script', 70]]),
      queueItem('listing', 45, '2100 Victoria Ave · Regina', 'listing · $1,500/mo · 2 bed',
                4 * 86400, [['user_report_scam', 45]]),
      queueItem('listing', 12, '919 Retallack St · Regina', 'listing · $1,320/mo · 2 bed',
                26 * 3600, []),
    ],
  })],
  ['admin-queue-empty', queuePage({
    viewer: STAFF, state: 'open',
    stats: { open: 0, openListings: 0, openMessages: 0, oldestWaitingSec: null,
             blockedLast7d: 2, releasedLast7d: 1 },
    items: [],
  })],
  ['admin-listing', listingReviewPage({
    viewer: STAFF,
    listing: {
      id: 'l1', title: LISTING.title, description: LISTING.description,
      descriptionSource: 'ai', priceCents: 150_000, mode: 'rent',
      beds: 2, baths: 1, sqft: 820, amenities: LISTING.amenities.slice(0, 5),
      status: 'pending_review',
      address: { addressLine: '2100 Victoria Ave', city: 'Regina', province: 'SK' },
    },
    signals: [{ signal: 'price_outlier', weight: 30 }, { signal: 'new_account', weight: 10 }],
    reports: [
      { kind: 'scam', detail: 'These are photos of my own flat.', createdAt: AT },
      { kind: 'misleading', detail: null, createdAt: AT },
    ],
  })],
  ['admin-message', messageReviewPage({
    viewer: STAFF,
    message: {
      id: 'm1',
      body: 'I am currently abroad but the flat is available. Send the deposit by '
        + 'e-transfer today and I will courier the keys to you this week.',
      verdict: 'block',
      flaggedReasons: ['money_request', 'absent_landlord_script'],
      delivered: false, isFirstContact: true, createdAt: AT,
      sender: { email: 'sender@example.test', emailVerified: false, blockedCount: 3 },
      recipient: { email: 'renter@example.test' },
      listing: { id: 'l1', title: 'Bright two bedroom in Cathedral' },
      context: [
        { body: 'Hi — is this still available?', mine: false, createdAt: AT },
        { body: 'Yes it is.', mine: true, createdAt: AT },
      ],
    },
  })],
  ['admin-flags', flagsPage({
    viewer: ADMIN, cache: 'fresh',
    flags: FLAG_KEYS.map((key, i) => ({
      key, label: FLAGS[key].label, tier: FLAGS[key].tier,
      effect: FLAGS[key].effect, failsafe: FLAGS[key].failsafe,
      configured: i === 0,
      enabled: i === 0 ? false : defaultStateOf(key).enabled,
      rolloutPct: defaultStateOf(key).rolloutPct,
      note: i === 0 ? 'SES bounce spike, ticket 41' : null,
      updatedBy: null, updatedAt: i === 0 ? AT : null,
    })),
  })],
  ['admin-flags-blind', flagsPage({
    viewer: STAFF, cache: 'blind',
    flags: FLAG_KEYS.slice(0, 3).map((key) => ({
      key, label: FLAGS[key].label, tier: FLAGS[key].tier,
      effect: FLAGS[key].effect, failsafe: FLAGS[key].failsafe,
      configured: false, enabled: true, rolloutPct: 100,
      note: null, updatedBy: null, updatedAt: null,
    })),
  })],
];

function photo(id: string, position: number) {
  return {
    id, storageKey: `listings/x/${id}`, kind: 'photo',
    mime: 'image/jpeg', bytes: 240_000, position,
  };
}

function thread(id: string, listingTitle: string, unreadCount: number,
                role: 'owner' | 'inquirer', lastPreview: string | null) {
  return {
    id, listingId: 'l1', listingTitle, listingStatus: 'live',
    counterpartyId: 'other', status: 'open' as const, role,
    messageCount: 3, unreadCount, lastAt: AT, lastPreview, blockedByMe: false,
  };
}

function msg(mine: boolean, body: string, flagged: boolean) {
  return { id: Math.random().toString(36), senderId: mine ? 'o' : 'x', body,
           kind: 'text', createdAt: AT, flagged, mine };
}

function queueItem(subjectType: 'listing' | 'message', riskScore: number,
                   title: string, subtitle: string, waitingSec: number,
                   signals: Array<[string, number]>) {
  return {
    id: `q-${title.slice(0, 6)}`, subjectType, subjectId: 'x',
    reason: 'auto', riskScore, state: 'open' as const,
    createdAt: new Date(AT.getTime() - waitingSec * 1000), waitingSec,
    title, subtitle,
    signals: signals.map(([signal, weight]) => ({ signal, weight, detail: {}, at: AT })),
  };
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  for (const [name, markup] of PAGES) {
    await writeFile(`${OUT}/${name}.html`, markup, 'utf8');
    console.log(`${name}.html  ${markup.length.toLocaleString('en-CA')} bytes`);
  }
  console.log(`\n${PAGES.length} pages -> ${OUT}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
