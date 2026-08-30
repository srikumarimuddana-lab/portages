/**
 * Listing content rules.
 *
 * Everything here is pure. It is the layer that decides what a listing may
 * say, not who may say it — and it exists separately from the service because
 * these are the rules most likely to change as Regina teaches us things, and
 * they should be changeable without touching a query.
 */

/**
 * Amenities are an allowlist, not free text.
 *
 * The `amenities text[]` column carries no CHECK constraint and is GIN-indexed
 * for faceted search, so without a gate here an owner can write anything into
 * it — and the two things people write into an unguarded facet are marketing
 * copy and a phone number. Facets are also rendered as chips and used as
 * filters, so a free-text value is both a spam surface and a way to make a
 * listing unfindable-but-present.
 *
 * The Saskatchewan-specific entries are not padding: a heated garage and a
 * block-heater plug are among the first things a Regina renter filters on
 * between November and March.
 */
export const AMENITIES = [
  // parking
  'parking', 'garage', 'heated_garage', 'block_heater_plug', 'ev_charger',
  // laundry
  'in_suite_laundry', 'shared_laundry', 'laundry_hookups',
  // climate
  'air_conditioning', 'central_heating', 'fireplace',
  // outdoor
  'balcony', 'patio', 'yard', 'fenced_yard', 'deck',
  // building
  'elevator', 'wheelchair_accessible', 'security_system', 'concierge',
  'bike_storage', 'storage_locker', 'gym', 'pool', 'hot_tub', 'sauna',
  // interior
  'dishwasher', 'furnished', 'basement', 'finished_basement',
  'ensuite_bathroom', 'walk_in_closet', 'central_vac',
  // pets and smoking — filters people actually use
  'pets_allowed', 'cats_allowed', 'dogs_allowed', 'smoking_allowed',
  // included in rent
  'utilities_included', 'heat_included', 'water_included',
  'electricity_included', 'internet_included',
] as const;
export type Amenity = (typeof AMENITIES)[number];

const AMENITY_SET: ReadonlySet<string> = new Set(AMENITIES);

export const PROPERTY_TYPES = [
  'detached', 'semi_detached', 'condo', 'townhouse', 'apartment', 'cabin', 'land',
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const ROOM_TYPES = ['entire', 'private', 'shared'] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const DESCRIPTION_SOURCES = ['human', 'ai_assisted', 'ai_generated'] as const;
export type DescriptionSource = (typeof DESCRIPTION_SOURCES)[number];

export const MAX_PHOTOS = 30;
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
export const ALLOWED_PHOTO_MIME: ReadonlySet<string> = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/avif',
]);

// ── price ────────────────────────────────────────────────────────────────────

/**
 * Absolute price bands, in cents. Outside these a number is not a price, it
 * is a typo or a hook — and both are worth refusing rather than publishing.
 *
 * Deliberately wide. The job here is to catch the missing or extra three
 * zeros, not to have an opinion about what Regina property is worth.
 */
export const PRICE_BANDS = {
  rent: { min: 20_000, max: 2_000_000 },              // $200 – $20,000 / month
  sale: { min: 1_000_000, max: 5_000_000_000 },       // $10,000 – $50,000,000
} as const;

/**
 * Prices that are legal but implausible for Regina, worth a look rather than
 * a refusal. The classic rental-scam hook is a real address and a real
 * photoset at half the going rate, collecting deposits from people who never
 * see the unit.
 */
export const PRICE_SUSPICION = {
  rent: 40_000,      // under $400/month
  sale: 4_000_000,   // under $40,000
} as const;

export type PriceVerdict =
  | { ok: true }
  | { ok: false; reason: 'below_band' | 'above_band' };

export function checkPrice(priceCents: number, mode: 'sale' | 'rent'): PriceVerdict {
  const band = PRICE_BANDS[mode];
  if (priceCents < band.min) return { ok: false, reason: 'below_band' };
  if (priceCents > band.max) return { ok: false, reason: 'above_band' };
  return { ok: true };
}

export function priceRejectionMessage(reason: 'below_band' | 'above_band', mode: 'sale' | 'rent'): string {
  const band = PRICE_BANDS[mode];
  const lo = (band.min / 100).toLocaleString('en-CA');
  const hi = (band.max / 100).toLocaleString('en-CA');
  const per = mode === 'rent' ? ' per month' : '';
  return reason === 'below_band'
    ? `Price looks too low. Expected at least $${lo}${per} — check for a missing digit.`
    : `Price looks too high. Expected at most $${hi}${per} — check for an extra digit.`;
}

// ── address normalization ────────────────────────────────────────────────────

/**
 * Street-type and direction abbreviations, expanded so that "123 Main St NW"
 * and "123 main street northwest" collapse to the same key.
 *
 * This matters more than it looks: `properties_addr_idx` is UNIQUE on
 * (address_norm, city, province) and `listings_one_live_per_property` allows
 * one live listing per property. Those two indexes are the entire duplicate
 * defence, and they are only as good as this function. A normalizer that
 * misses "St." vs "Street" lets the same unit be posted twice.
 */
const STREET_TYPES: Readonly<Record<string, string>> = {
  st: 'street', str: 'street', ave: 'avenue', av: 'avenue', rd: 'road',
  dr: 'drive', blvd: 'boulevard', cres: 'crescent', cr: 'crescent',
  pl: 'place', ct: 'court', crt: 'court', ln: 'lane', terr: 'terrace',
  tr: 'terrace', pkwy: 'parkway', hwy: 'highway', sq: 'square',
  gdns: 'gardens', gdn: 'garden', cir: 'circle', bay: 'bay', way: 'way',
};

const DIRECTIONS: Readonly<Record<string, string>> = {
  n: 'north', s: 'south', e: 'east', w: 'west',
  ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
};

/**
 * Reduces a street address to a comparison key.
 *
 * Not for display — the original `address_line` is kept verbatim for that.
 * This output only ever appears in an index.
 */
export function normalizeAddress(addressLine: string): string {
  const cleaned = addressLine
    .normalize('NFKD')
    // Strip accents so "Boulevard Saint-Michel" keys the same either way.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Punctuation becomes whitespace rather than vanishing, so "st.michael"
    // does not become one token.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (!cleaned) return '';

  return cleaned
    .split(' ')
    .map((tok) => STREET_TYPES[tok] ?? DIRECTIONS[tok] ?? tok)
    .join(' ');
}

/**
 * The duplicate-detection key for a property, unit included.
 *
 * The unit MUST be part of this. `properties_addr_idx` is unique on
 * (address_norm, city, province), so if the unit were left out of the key
 * every apartment in a building would collapse into one property row — and
 * `listings_one_live_per_property` would then permit exactly one live listing
 * for the whole building. That is a 404-unit tower reduced to a single
 * advertisable suite.
 */
export function propertyKey(addressLine: string, unit?: string | null): string {
  const base = normalizeAddress(addressLine);
  const u = normalizeUnit(unit);
  return u ? `${base} unit ${u}` : base;
}

/** Strips the ways people write a unit: "#4", "Apt. 4", "Suite 4", "Unit 4". */
export function normalizeUnit(unit: string | null | undefined): string {
  if (!unit) return '';
  return unit
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:apt|apartment|suite|ste|unit|no|number)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `room_type` describes how a rental is shared. It has no meaning for a sale,
 * and accepting it there produces listings that filter into nonsense.
 */
export function roomTypeAllowed(mode: 'sale' | 'rent'): boolean {
  return mode === 'rent';
}

/** Canada Post format, normalized to "S4P 3Y2". Returns null if unparseable. */
export function normalizePostalCode(input: string | undefined | null): string | null {
  if (!input) return null;
  const compact = input.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z][0-9][A-Z][0-9][A-Z][0-9]$/.test(compact)) return null;
  return `${compact.slice(0, 3)} ${compact.slice(3)}`;
}

// ── content risk ─────────────────────────────────────────────────────────────

export interface RiskSignal {
  signal: string;
  weight: number;
  detail: Record<string, unknown>;
}

// Loose on purpose: this is a detector, not a validator. It should fire on
// "three oh six five five five one two three four" written with spaces and
// dots, because that is how someone evading a phone filter writes it.
const PHONE_RE = /(?:\+?1[\s.\-]*)?\(?\d{3}\)?[\s.\-]*\d{3}[\s.\-]*\d{4}/;
const EMAIL_RE = /[a-z0-9._%+-]+\s*(?:@|\(at\)|\[at\])\s*[a-z0-9.-]+\.[a-z]{2,}/i;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;

/**
 * Words that mean the same thing in every rental-scam post: move the money
 * before you see the unit. None of these is proof of anything on its own,
 * which is why they carry weight rather than a verdict.
 */
const OFF_PLATFORM_TERMS = [
  'western union', 'moneygram', 'wire transfer', 'e-transfer only',
  'interac only', 'bitcoin', 'crypto', 'gift card', 'cashier check',
  'cashier cheque', 'deposit before viewing', 'sight unseen',
  'i am currently abroad', 'out of the country', 'missionary', 'god bless',
];

/**
 * Scores listing copy for the signals worth a moderator's attention.
 *
 * Nothing here blocks a listing. It writes to `risk_signals` and orders the
 * moderation queue — the queue is ordered by `risk_score` precisely so that a
 * cheap heuristic can decide what a human looks at first without deciding
 * anything on its own.
 */
export function scanContent(input: { title: string; description?: string | null }): RiskSignal[] {
  const text = `${input.title}\n${input.description ?? ''}`;
  const signals: RiskSignal[] = [];

  // Contact details in the body are how a listing moves the conversation off
  // the platform before either side is verified — which is also exactly what
  // a scam needs. Worth flagging, not worth blocking: plenty of honest owners
  // do it out of habit.
  if (PHONE_RE.test(text)) {
    signals.push({ signal: 'contact_phone_in_body', weight: 12, detail: { field: 'description' } });
  }
  if (EMAIL_RE.test(text)) {
    signals.push({ signal: 'contact_email_in_body', weight: 12, detail: { field: 'description' } });
  }
  if (URL_RE.test(text)) {
    signals.push({ signal: 'external_link_in_body', weight: 8, detail: { field: 'description' } });
  }

  const lower = text.toLowerCase();
  const hits = OFF_PLATFORM_TERMS.filter((t) => lower.includes(t));
  if (hits.length > 0) {
    signals.push({
      signal: 'off_platform_payment_language',
      // Each additional phrase is more than additive evidence, but cap it so
      // one long quoted passage cannot dominate the queue.
      weight: Math.min(20 + hits.length * 10, 60),
      detail: { terms: hits },
    });
  }

  // ALL CAPS across a whole title is a spam tell and unpleasant to read.
  const letters = input.title.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 12 && letters === letters.toUpperCase()) {
    signals.push({ signal: 'shouting_title', weight: 4, detail: {} });
  }

  return signals;
}

/** Adds the price signal, which needs the mode that scanContent does not see. */
export function scanPrice(priceCents: number, mode: 'sale' | 'rent'): RiskSignal[] {
  if (priceCents >= PRICE_SUSPICION[mode]) return [];
  return [{
    signal: 'implausibly_low_price',
    weight: 25,
    detail: { priceCents, mode },
  }];
}

export function riskScore(signals: readonly RiskSignal[]): number {
  // The column is numeric(6,2); keep the total inside it.
  return Math.min(signals.reduce((sum, s) => sum + s.weight, 0), 9999);
}

/**
 * Whether an edit is material enough to re-open moderation on a LIVE listing.
 *
 * Price and inventory facts change legitimately and often — a price drop is
 * the most common edit there is, and forcing it back through review would
 * make owners stop using the feature. Copy is different: rewriting the
 * description of an approved listing is how an approved listing becomes a
 * different listing.
 *
 * So: copy changes re-open review only when the NEW copy actually trips a
 * signal. A typo fix stays live; a rewrite that adds a wire-transfer request
 * does not.
 */
export function rescanRequired(before: { title: string; description: string | null },
                               after: { title: string; description: string | null }): boolean {
  const copyChanged = before.title !== after.title || before.description !== after.description;
  if (!copyChanged) return false;
  return scanContent({ title: after.title, description: after.description }).length > 0;
}

// ── amenities ────────────────────────────────────────────────────────────────

export type AmenityVerdict =
  | { ok: true; value: Amenity[] }
  | { ok: false; unknown: string[] };

/** Rejects unknown amenities rather than dropping them silently. */
export function normalizeAmenities(input: readonly string[]): AmenityVerdict {
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const raw of input) {
    const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!AMENITY_SET.has(key)) {
      // Echoed back so the client can correct it; bounded so an attacker
      // cannot use the error body as an amplifier.
      if (unknown.length < 10) unknown.push(raw.slice(0, 40));
      continue;
    }
    seen.add(key);
  }
  if (unknown.length > 0) return { ok: false, unknown };
  // Sorted so the stored array is stable and two identical sets compare equal.
  return { ok: true, value: [...seen].sort() as Amenity[] };
}

// ── publish readiness ────────────────────────────────────────────────────────

export interface PublishCandidate {
  title: string;
  description: string | null;
  priceCents: number;
  mode: 'sale' | 'rent';
  propertyType: PropertyType;
  photoCount: number;
  descriptionSource: DescriptionSource;
  descriptionAttestedAt: Date | null;
  ownerEmailVerified: boolean;
}

/**
 * What must be true before a listing may be submitted for review.
 *
 * Returns every problem at once. A form that reveals one missing field per
 * round-trip is how people abandon a listing halfway.
 */
export function publishBlockers(c: PublishCandidate): string[] {
  const problems: string[] = [];

  if (c.title.trim().length < 8) {
    problems.push('Give the listing a title of at least 8 characters.');
  }
  if (!c.description || c.description.trim().length < 40) {
    problems.push('Add a description of at least 40 characters.');
  }
  // Land is the one type people genuinely list without photos.
  if (c.photoCount < 1 && c.propertyType !== 'land') {
    problems.push('Add at least one photo.');
  }
  if (c.photoCount > MAX_PHOTOS) {
    problems.push(`Remove some photos — the limit is ${MAX_PHOTOS}.`);
  }

  const price = checkPrice(c.priceCents, c.mode);
  if (!price.ok) problems.push(priceRejectionMessage(price.reason, c.mode));

  // The database trigger enforces this too (006, listings_publish_guard).
  // Checking here as well is not redundant: it produces a fixable message
  // instead of a constraint violation the user cannot act on.
  if (c.descriptionSource !== 'human' && !c.descriptionAttestedAt) {
    problems.push('Confirm that you have read and stand behind the AI-written description.');
  }

  // Verifying an email costs an attacker nothing but time, which is the point:
  // it makes bulk posting slow rather than free. It is not identity proof and
  // is not treated as any.
  if (!c.ownerEmailVerified) {
    problems.push('Verify your email address before publishing a listing.');
  }

  return problems;
}

/** The text FTS runs over. Kept in one place so index and query agree. */
export function buildSearchText(input: {
  title: string;
  description: string | null;
  addressLine: string;
  city: string;
  neighbourhood?: string | null;
  propertyType: string;
  amenities: readonly string[];
}): string {
  return [
    input.title,
    input.description ?? '',
    input.addressLine,
    input.city,
    input.neighbourhood ?? '',
    input.propertyType.replace(/_/g, ' '),
    input.amenities.join(' ').replace(/_/g, ' '),
  ]
    .filter(Boolean)
    .join(' \n ')
    .slice(0, 20_000);
}
