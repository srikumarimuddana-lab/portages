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

const PAGES: Array<[string, string]> = [
  ['home', homePage({ viewer: null, recent: CARDS, liveCount: 128 })],
  ['search', searchPage({
    viewer: { userId: 'u1', role: 'user' },
    query: 'two bed under $1500 with parking',
    results: { results: CARDS.slice(0, 6), sort: 'relevance' },
    reading: 'Two bedrooms, up to $1,500 a month, with parking.',
  })],
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
    viewer: null, listing: LISTING, origin: 'https://portage.ca',
  })],
  ['listing-owner', listingPage({
    viewer: { userId: 'owner', role: 'user' },
    listing: { ...LISTING, isOwner: true },
    origin: 'https://portage.ca',
  })],
  ['listing-hostile', listingPage({
    viewer: null, listing: HOSTILE, origin: 'https://portage.ca',
  })],
  ['signin', signInPage({})],
  ['signin-error', signInPage({ error: 'That email and password did not match.' })],
];

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
