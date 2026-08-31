/**
 * Listing tests.
 *
 * Split of responsibility, the same one ratelimit-db.test.ts uses:
 *
 *   - The database's own behaviour — the partial unique index, the publish
 *     guard trigger, ON CONFLICT against a partial index, the property upsert
 *     — is verified against real PostgreSQL in test/sql/listings.sql, which CI
 *     runs on every pull request.
 *
 *   - This file covers the TypeScript half: the state machine, the content
 *     policy, and the service's decisions, against a fake Sql. That keeps
 *     these runnable with no database and no driver installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canTransition, resolveAction, availableActions, isPublic,
  TRANSITIONS, TERMINAL_STATUSES, LISTING_STATUSES,
} from '../src/modules/listings/state.js';
import {
  AMENITIES, PRICE_BANDS, MAX_PHOTOS,
  buildSearchText, checkPrice, normalizeAddress, normalizeAmenities,
  normalizePostalCode, normalizeUnit, propertyKey, publishBlockers,
  rescanRequired, riskScore, roomTypeAllowed, scanContent, scanPrice,
} from '../src/modules/listings/policy.js';
import { ListingService, isUniqueViolation } from '../src/modules/listings/service.js';
import { AppError } from '../src/lib/errors.js';
import type { Sql, QueryResult } from '../src/db/pool.js';

// ── state machine ────────────────────────────────────────────────────────────

test('state: an owner cannot approve their own listing', () => {
  const v = resolveAction('approve', 'pending_review', 'owner', 'rent');
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'wrong_actor');
});

test('state: staff approval moves pending_review to live', () => {
  const v = resolveAction('approve', 'pending_review', 'staff', 'rent');
  assert.deepEqual(v, { ok: true, to: 'live' });
});

test('state: close resolves by mode — rent becomes rented, sale becomes sold', () => {
  assert.deepEqual(resolveAction('close', 'live', 'owner', 'rent'), { ok: true, to: 'rented' });
  assert.deepEqual(resolveAction('close', 'live', 'owner', 'sale'), { ok: true, to: 'sold' });
});

test('state: a sale cannot be marked rented, nor a rental sold', () => {
  assert.equal(canTransition('live', 'rented', 'owner', 'sale').ok, false);
  assert.equal(canTransition('live', 'sold', 'owner', 'rent').ok, false);
  const v = canTransition('live', 'sold', 'owner', 'rent');
  assert.equal(v.ok === false && v.reason, 'wrong_mode');
});

test('state: rented and sold are terminal', () => {
  for (const from of TERMINAL_STATUSES) {
    for (const to of LISTING_STATUSES) {
      const v = canTransition(from, to, 'staff', 'rent');
      assert.equal(v.ok, false, `${from} -> ${to} must be refused`);
    }
    assert.deepEqual(availableActions(from, 'owner', 'rent'), []);
  }
});

test('state: nothing reaches live except through staff approval', () => {
  const toLive = TRANSITIONS.filter((t) => t.to === 'live');
  for (const t of toLive) {
    if (t.from === 'paused') {
      // Resuming something already approved is the owner's call.
      assert.deepEqual(t.actors, ['owner']);
    } else {
      assert.deepEqual(t.actors, ['staff'], `${t.from} -> live must be staff-only`);
      assert.equal(t.from, 'pending_review');
    }
  }
});

test('state: no client-namable action produces a system transition', () => {
  for (const t of TRANSITIONS) {
    if (t.actors.length === 1 && t.actors[0] === 'system') {
      assert.equal(t.action, undefined, `${t.from} -> ${t.to} must not be requestable`);
    }
  }
});

test('state: only live is public', () => {
  for (const s of LISTING_STATUSES) {
    assert.equal(isPublic(s), s === 'live', `${s} visibility`);
  }
});

test('state: a draft owner sees submit and nothing else', () => {
  assert.deepEqual(availableActions('draft', 'owner', 'rent'), ['submit']);
  assert.deepEqual(availableActions('draft', 'staff', 'rent'), []);
});

test('state: a rejected listing can be revised rather than being a dead end', () => {
  assert.deepEqual(resolveAction('revise', 'rejected', 'owner', 'sale'), { ok: true, to: 'draft' });
});

// ── address normalization ────────────────────────────────────────────────────

test('policy: street-type spellings collapse to one key', () => {
  const forms = [
    '123 Victoria Ave', '123 Victoria Avenue', '123 victoria ave.',
    '123  Victoria   AVE', '123 Victoria Av',
  ];
  const keys = new Set(forms.map((f) => normalizeAddress(f)));
  assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(' | ')}`);
});

test('policy: direction suffixes normalize', () => {
  assert.equal(normalizeAddress('50 Main St NW'), normalizeAddress('50 main street northwest'));
  assert.equal(normalizeAddress('7 Elm Cres SE'), normalizeAddress('7 elm crescent southeast'));
});

test('policy: punctuation does not merge tokens', () => {
  // "st.michael" must not become one word, or it stops matching "St Michael".
  assert.equal(normalizeAddress('12 St. Michael Bay'), '12 street michael bay');
});

test('policy: accents fold', () => {
  assert.equal(normalizeAddress('9 Boulevard Saint-Michel'), normalizeAddress('9 boulevard saint michel'));
});

test('policy: the unit is part of the property key', () => {
  // If it were not, every apartment in a building would share one property
  // row, and one live listing would cover the whole tower.
  const a = propertyKey('123 Victoria Ave', '4');
  const b = propertyKey('123 Victoria Ave', '5');
  const bare = propertyKey('123 Victoria Ave', null);
  assert.notEqual(a, b);
  assert.notEqual(a, bare);
});

test('policy: unit spellings normalize', () => {
  for (const u of ['4', '#4', 'Apt 4', 'Apt. 4', 'Suite 4', 'Unit 4', 'STE 4']) {
    assert.equal(normalizeUnit(u), '4', `unit "${u}"`);
  }
  assert.equal(normalizeUnit(null), '');
});

test('policy: postal codes normalize, and garbage is rejected', () => {
  assert.equal(normalizePostalCode('s4p0n7'), 'S4P 0N7');
  assert.equal(normalizePostalCode('S4P 0N7'), 'S4P 0N7');
  assert.equal(normalizePostalCode('90210'), null);
  assert.equal(normalizePostalCode(''), null);
  assert.equal(normalizePostalCode(undefined), null);
});

// ── price ────────────────────────────────────────────────────────────────────

test('policy: price bands catch the missing and extra digit', () => {
  assert.equal(checkPrice(150_000, 'rent').ok, true);         // $1,500/mo
  assert.equal(checkPrice(1_500, 'rent').ok, false);          // $15/mo
  assert.equal(checkPrice(500_000_000, 'rent').ok, false);    // $5,000,000/mo
  assert.equal(checkPrice(42_500_000, 'sale').ok, true);      // $425,000
  assert.equal(checkPrice(42_500, 'sale').ok, false);         // $425
});

test('policy: band edges are inclusive', () => {
  for (const mode of ['rent', 'sale'] as const) {
    assert.equal(checkPrice(PRICE_BANDS[mode].min, mode).ok, true, `${mode} min`);
    assert.equal(checkPrice(PRICE_BANDS[mode].max, mode).ok, true, `${mode} max`);
    assert.equal(checkPrice(PRICE_BANDS[mode].min - 1, mode).ok, false, `${mode} below`);
    assert.equal(checkPrice(PRICE_BANDS[mode].max + 1, mode).ok, false, `${mode} above`);
  }
});

test('policy: an implausibly low price is flagged, not refused', () => {
  // The classic rental scam: real address, real photos, half the going rate.
  assert.equal(checkPrice(30_000, 'rent').ok, true);
  assert.equal(scanPrice(30_000, 'rent').length, 1);
  assert.equal(scanPrice(150_000, 'rent').length, 0);
});

// ── content risk ─────────────────────────────────────────────────────────────

test('policy: contact details in the body raise a signal', () => {
  const withPhone = scanContent({ title: 'Nice suite', description: 'Call 306-555-0134' });
  assert.ok(withPhone.some((s) => s.signal === 'contact_phone_in_body'));

  const withEmail = scanContent({ title: 'Nice suite', description: 'me (at) example.com' });
  assert.ok(withEmail.some((s) => s.signal === 'contact_email_in_body'));
});

test('policy: clean copy raises nothing', () => {
  assert.deepEqual(
    scanContent({ title: 'Bright two bedroom in Cathedral', description: 'Close to the park.' }),
    [],
  );
});

test('policy: off-platform payment language scores high', () => {
  const s = scanContent({
    title: 'Lovely home',
    description: 'I am currently abroad, please send a wire transfer deposit before viewing.',
  });
  const hit = s.find((x) => x.signal === 'off_platform_payment_language')!;
  assert.ok(hit, 'must flag the phrases');
  assert.ok(hit.weight >= 30, `weight ${hit.weight} should reflect multiple hits`);
  assert.ok(riskScore(s) >= 30);
});

test('policy: signal weight is capped so one passage cannot flood the queue', () => {
  const s = scanContent({
    title: 'x',
    description: 'western union moneygram wire transfer bitcoin crypto gift card ' +
                 'cashier check sight unseen out of the country god bless',
  });
  const hit = s.find((x) => x.signal === 'off_platform_payment_language')!;
  assert.ok(hit.weight <= 60, `weight ${hit.weight} must stay capped`);
});

test('policy: rescan only re-opens review when the NEW copy is a problem', () => {
  const before = { title: 'Bright two bedroom', description: 'Close to the park.' };

  // A typo fix stays live.
  assert.equal(
    rescanRequired(before, { title: 'Bright 2 bedroom', description: 'Close to the park.' }),
    false,
  );
  // Editing an approved listing into a scam does not.
  assert.equal(
    rescanRequired(before, { title: before.title, description: 'Wire transfer only, I am abroad.' }),
    true,
  );
  // No change at all is never a rescan.
  assert.equal(rescanRequired(before, { ...before }), false);
});

// ── amenities ────────────────────────────────────────────────────────────────

test('policy: unknown amenities are rejected, not dropped', () => {
  const v = normalizeAmenities(['parking', 'CALL 306-555-0134']);
  assert.equal(v.ok, false);
  assert.deepEqual(v.ok === false && v.unknown, ['CALL 306-555-0134']);
});

test('policy: amenities normalize spacing and case, and de-duplicate', () => {
  const v = normalizeAmenities(['Parking', 'parking', 'In Suite Laundry', 'in-suite-laundry']);
  assert.equal(v.ok, true);
  assert.deepEqual(v.ok === true && v.value, ['in_suite_laundry', 'parking']);
});

test('policy: the echoed unknown list is bounded', () => {
  const v = normalizeAmenities(Array.from({ length: 50 }, (_, i) => `bogus${i}`));
  assert.equal(v.ok, false);
  assert.ok(v.ok === false && v.unknown.length <= 10);
});

test('policy: every allowlisted amenity survives a round trip', () => {
  const v = normalizeAmenities([...AMENITIES]);
  assert.equal(v.ok, true);
  assert.equal(v.ok === true && v.value.length, AMENITIES.length);
});

test('policy: room type is a rental concept only', () => {
  assert.equal(roomTypeAllowed('rent'), true);
  assert.equal(roomTypeAllowed('sale'), false);
});

// ── publish readiness ────────────────────────────────────────────────────────

const READY = {
  title: 'Bright two bedroom in Cathedral',
  description: 'A well-kept two bedroom a short walk from the park and 13th Ave shops.',
  priceCents: 150_000,
  mode: 'rent' as const,
  propertyType: 'apartment' as const,
  photoCount: 3,
  descriptionSource: 'human' as const,
  descriptionAttestedAt: null,
  ownerEmailVerified: true,
};

test('publish: a complete listing has no blockers', () => {
  assert.deepEqual(publishBlockers(READY), []);
});

test('publish: every problem is reported at once', () => {
  const blockers = publishBlockers({
    ...READY, title: 'x', description: null, photoCount: 0, ownerEmailVerified: false,
  });
  assert.ok(blockers.length >= 4, `expected several blockers, got ${blockers.length}`);
});

test('publish: unattested AI copy is blocked before it reaches the trigger', () => {
  const blockers = publishBlockers({ ...READY, descriptionSource: 'ai_generated' });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0]!, /stand behind/);

  assert.deepEqual(
    publishBlockers({
      ...READY, descriptionSource: 'ai_generated', descriptionAttestedAt: new Date(),
    }),
    [],
  );
});

test('publish: an unverified email blocks publication', () => {
  const blockers = publishBlockers({ ...READY, ownerEmailVerified: false });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0]!, /Verify your email/);
});

test('publish: land may be listed without photos, a condo may not', () => {
  assert.deepEqual(publishBlockers({ ...READY, propertyType: 'land', photoCount: 0 }), []);
  assert.equal(publishBlockers({ ...READY, propertyType: 'condo', photoCount: 0 }).length, 1);
});

test('publish: too many photos is a blocker', () => {
  const blockers = publishBlockers({ ...READY, photoCount: MAX_PHOTOS + 1 });
  assert.ok(blockers.some((b) => b.includes(String(MAX_PHOTOS))));
});

test('search text carries the address and expands amenity underscores', () => {
  const text = buildSearchText({
    title: 'Bright two bedroom',
    description: 'Lovely.',
    addressLine: '123 Victoria Ave',
    city: 'Regina',
    propertyType: 'semi_detached',
    amenities: ['in_suite_laundry', 'heated_garage'],
  });
  assert.match(text, /Victoria/);
  assert.match(text, /Regina/);
  assert.match(text, /semi detached/);
  assert.match(text, /in suite laundry/);
});

// ── service, against a fake Sql ──────────────────────────────────────────────

interface FakeOpts {
  listing?: Record<string, unknown> | null;
  photoCount?: number;
  emailVerified?: boolean;
}

/**
 * Records every statement so a test can assert on what was NOT sent — which
 * is how the mass-assignment cases are checked.
 */
function fakeSql(opts: FakeOpts = {}): Sql & { sent: Array<{ text: string; params: readonly unknown[] }> } {
  const sent: Array<{ text: string; params: readonly unknown[] }> = [];

  const db: Sql & { sent: typeof sent } = {
    sent,
    async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
      sent.push({ text, params });
      const t = text.replace(/\s+/g, ' ').trim();

      if (t.startsWith('INSERT INTO properties')) {
        return { rows: [{ id: 'prop-1' } as unknown as R], rowCount: 1 };
      }
      if (t.includes('FROM listings l') || t.startsWith('SELECT id FROM listings')) {
        const row = opts.listing === undefined ? defaultListing(opts) : opts.listing;
        return row
          ? { rows: [row as unknown as R], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      // Two different statements count photos: addPhoto (which also needs the
      // next position) and the publish check. Both land here.
      if (t.includes('count(*)') && t.includes('FROM listing_media')) {
        return {
          rows: [{ n: String(opts.photoCount ?? 0), next: String(opts.photoCount ?? 0) } as unknown as R],
          rowCount: 1,
        };
      }
      if (t.includes('FROM listing_media')) return { rows: [], rowCount: 0 };
      if (t.includes('FROM risk_signals')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  return db;
}

function defaultListing(opts: FakeOpts): Record<string, unknown> {
  return {
    id: 'listing-1',
    property_id: 'prop-1',
    owner_id: 'owner-1',
    mode: 'rent',
    status: 'draft',
    price_cents: '150000',
    room_type: null,
    property_type: 'apartment',
    beds: 2,
    baths: '1.0',
    sqft: 800,
    amenities: ['parking'],
    title: 'Bright two bedroom in Cathedral',
    description: 'A well-kept two bedroom a short walk from the park and shops.',
    description_source: 'human',
    description_attested_at: null,
    published_at: null,
    expires_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    address_line: '123 Victoria Ave',
    unit: null,
    city: 'Regina',
    province: 'SK',
    postal_code: 'S4P 0N7',
    lat: null,
    lng: null,
    email_verified_at: opts.emailVerified === false ? null : new Date(),
  };
}

const OWNER = { userId: 'owner-1', role: 'user' as const };
const STRANGER = { userId: 'someone-else', role: 'user' as const };
const STAFF = { userId: 'staff-1', role: 'staff' as const };

function svc(opts: FakeOpts = {}) {
  const db = fakeSql(opts);
  return { db, listings: new ListingService(db, 'test-storage-secret') };
}

const CREATE = {
  ownerId: 'owner-1',
  mode: 'rent' as const,
  propertyType: 'apartment' as const,
  priceCents: 150_000,
  title: 'Bright two bedroom in Cathedral',
  description: 'A well-kept two bedroom.',
  address: { addressLine: '123 Victoria Ave', city: 'Regina', province: 'SK' },
};

test('service: create always writes a draft', async () => {
  const { db, listings } = svc();
  await listings.create(CREATE);
  const insert = db.sent.find((s) => s.text.includes('INSERT INTO listings'))!;
  assert.ok(insert, 'must insert a listing');
  assert.match(insert.text, /'draft'/, 'status must be a literal draft, not a parameter');
});

test('service: create refuses an unknown amenity', async () => {
  const { listings } = svc();
  await assert.rejects(
    () => listings.create({ ...CREATE, amenities: ['jacuzzi_helipad'] }),
    (err: AppError) => err.status === 400,
  );
});

test('service: create refuses a room type on a sale', async () => {
  const { listings } = svc();
  await assert.rejects(
    () => listings.create({ ...CREATE, mode: 'sale', priceCents: 42_500_000, roomType: 'private' }),
    (err: AppError) => err.status === 400 && /rentals only/.test(err.message),
  );
});

test('service: create refuses a price outside the band', async () => {
  const { listings } = svc();
  await assert.rejects(
    () => listings.create({ ...CREATE, priceCents: 1_500 }),
    (err: AppError) => err.status === 400 && /missing digit/.test(err.message),
  );
});

test('service: create records the risk signals it found', async () => {
  const { db, listings } = svc();
  await listings.create({ ...CREATE, description: 'Call me at 306-555-0134, wire transfer only.' });
  const signals = db.sent.filter((s) => s.text.includes('INSERT INTO risk_signals'));
  assert.ok(signals.length >= 2, `expected phone + payment signals, got ${signals.length}`);
});

test('service: create rejects a malformed postal code rather than storing it', async () => {
  const { listings } = svc();
  await assert.rejects(
    () => listings.create({ ...CREATE, address: { ...CREATE.address, postalCode: '90210' } }),
    (err: AppError) => err.status === 400,
  );
});

test('service: a stranger cannot see a draft, and is told it does not exist', async () => {
  const { listings } = svc();
  await assert.rejects(
    () => listings.get('listing-1', STRANGER),
    (err: AppError) => err.status === 404,   // not 403: 403 confirms it exists
  );
});

test('service: the owner sees their own draft, with the actions open to them', async () => {
  const { listings } = svc();
  const view = await listings.get('listing-1', OWNER);
  assert.equal(view.status, 'draft');
  assert.equal(view.isOwner, true);
  assert.deepEqual(view.actions, ['submit']);
});

test('service: staff see a draft, with staff actions only', async () => {
  const { listings } = svc({ listing: { ...defaultListing({}), status: 'pending_review' } });
  const view = await listings.get('listing-1', STAFF);
  assert.equal(view.isOwner, false);
  assert.deepEqual(view.actions?.sort(), ['approve', 'reject']);
});

test('service: a live listing is visible to anyone', async () => {
  const { listings } = svc({ listing: { ...defaultListing({}), status: 'live' } });
  const view = await listings.get('listing-1', { userId: null, role: 'user' });
  assert.equal(view.status, 'live');
  assert.equal(view.isOwner, false);
});

test('service: update refuses a listing the caller does not own', async () => {
  const { listings } = svc();
  await assert.rejects(
    () => listings.update('listing-1', 'someone-else', { priceCents: 160_000 }),
    (err: AppError) => err.status === 404,
  );
});

test('service: update never writes a status the caller chose', async () => {
  const { db, listings } = svc();
  // `status` is not in UpdateListingInput; this is the runtime half of the
  // guarantee, in case a future edit widens the type.
  await listings.update('listing-1', 'owner-1', { status: 'live' } as never);
  const update = db.sent.find((s) => s.text.includes('UPDATE listings'))!;
  // The only status the statement can set is the one the service computed.
  assert.ok(!update.params.includes('live'), 'a client-supplied status must not reach the update');
});

test('service: editing the copy clears an existing attestation', async () => {
  const { db, listings } = svc({
    listing: {
      ...defaultListing({}),
      description_source: 'ai_generated',
      description_attested_at: new Date(),
      status: 'draft',
    },
  });
  await listings.update('listing-1', 'owner-1', { description: 'Rewritten by hand.' });
  const update = db.sent.find((s) => s.text.includes('UPDATE listings'))!;
  // Parameter 6 is description_attested_at.
  assert.equal(update.params[5], null, 'a rewrite must re-arm attestation');
});

test('service: a price change alone keeps the attestation', async () => {
  const attested = new Date();
  const { db, listings } = svc({
    listing: {
      ...defaultListing({}),
      description_source: 'ai_assisted',
      description_attested_at: attested,
    },
  });
  await listings.update('listing-1', 'owner-1', { priceCents: 160_000 });
  const update = db.sent.find((s) => s.text.includes('UPDATE listings'))!;
  assert.equal(update.params[5], attested);
});

test('service: editing a live listing into a scam sends it back to review', async () => {
  const { db, listings } = svc({ listing: { ...defaultListing({}), status: 'live' } });
  const out = await listings.update('listing-1', 'owner-1', {
    description: 'Wire transfer the deposit before viewing, I am currently abroad.',
  });
  assert.equal(out.rescanned, true);

  const update = db.sent.find((s) => s.text.includes('UPDATE listings'))!;
  assert.equal(update.params[12], 'pending_review');
  assert.ok(
    db.sent.some((s) => s.text.includes('INSERT INTO moderation_queue')),
    'it must land back in the queue',
  );
});

test('service: a harmless edit to a live listing leaves it live', async () => {
  const { db, listings } = svc({ listing: { ...defaultListing({}), status: 'live' } });
  const out = await listings.update('listing-1', 'owner-1', { title: 'Bright 2 bedroom in Cathedral' });
  assert.equal(out.rescanned, false);
  const update = db.sent.find((s) => s.text.includes('UPDATE listings'))!;
  assert.equal(update.params[12], 'live');
});

test('service: a closed listing cannot be edited', async () => {
  const { listings } = svc({ listing: { ...defaultListing({}), status: 'sold' } });
  await assert.rejects(
    () => listings.update('listing-1', 'owner-1', { priceCents: 160_000 }),
    (err: AppError) => err.status === 409,
  );
});

test('service: an empty patch is refused rather than issuing a no-op write', async () => {
  const { listings } = svc();
  await assert.rejects(
    () => listings.update('listing-1', 'owner-1', {}),
    (err: AppError) => err.status === 400,
  );
});

test('service: submit is blocked while the owner is unverified', async () => {
  const { listings } = svc({ emailVerified: false, photoCount: 2 });
  await assert.rejects(
    () => listings.transition('listing-1', OWNER, 'submit'),
    (err: AppError) => err.status === 400 && !!err.details?.some((d) => /Verify your email/.test(d)),
  );
});

test('service: submit is blocked without a photo', async () => {
  const { listings } = svc({ photoCount: 0 });
  await assert.rejects(
    () => listings.transition('listing-1', OWNER, 'submit'),
    (err: AppError) => !!err.details?.some((d) => /at least one photo/.test(d)),
  );
});

test('service: a ready listing submits and lands in the moderation queue', async () => {
  const { db, listings } = svc({ photoCount: 2 });
  const out = await listings.transition('listing-1', OWNER, 'submit');
  assert.equal(out.status, 'pending_review');
  assert.ok(db.sent.some((s) => s.text.includes('INSERT INTO moderation_queue')));
});

test('service: an owner cannot approve their own listing through the service either', async () => {
  const { listings } = svc({ listing: { ...defaultListing({}), status: 'pending_review' } });
  await assert.rejects(
    () => listings.transition('listing-1', OWNER, 'approve'),
    (err: AppError) => err.status === 409,
  );
});

test('service: a staff member cannot approve a listing they own', async () => {
  // The owner check comes first, so wearing a staff role on your own listing
  // still makes you the owner for the purposes of the state machine.
  const { listings } = svc({
    listing: { ...defaultListing({}), status: 'pending_review', owner_id: 'staff-1' },
  });
  await assert.rejects(
    () => listings.transition('listing-1', STAFF, 'approve'),
    (err: AppError) => err.status === 409,
  );
});

test('service: staff approval publishes and closes the queue entry', async () => {
  const { db, listings } = svc({ listing: { ...defaultListing({}), status: 'pending_review' } });
  const out = await listings.transition('listing-1', STAFF, 'approve');
  assert.equal(out.status, 'live');

  const update = db.sent.find((s) => /UPDATE listings\s+SET status = \$2/.test(s.text))!;
  assert.equal(update.params[2], true, 'going live must stamp published_at and expires_at');
  assert.ok(db.sent.some((s) => s.text.includes('UPDATE moderation_queue')));
});

test('service: a stranger gets 404 from transition, not a permission error', async () => {
  const { listings } = svc({ listing: { ...defaultListing({}), status: 'pending_review' } });
  await assert.rejects(
    () => listings.transition('listing-1', STRANGER, 'approve'),
    (err: AppError) => err.status === 404,
  );
});

test('service: a duplicate live listing becomes a 409, not a 500', async () => {
  const db = fakeSql({ listing: { ...defaultListing({}), status: 'paused' } });
  const inner = db.query.bind(db);
  db.query = async (text: string, params?: readonly unknown[]) => {
    if (text.includes('UPDATE listings') && text.includes('SET status')) {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505', constraint: 'listings_one_live_per_property',
      });
    }
    return inner(text, params);
  };
  const listings = new ListingService(db, 'test-storage-secret');
  await assert.rejects(
    () => listings.transition('listing-1', OWNER, 'resume'),
    (err: AppError) => err.status === 409 && /already published/.test(err.message),
  );
});

test('service: an unrelated unique violation is not swallowed', () => {
  const dup = { code: '23505', constraint: 'listings_one_live_per_property' };
  assert.equal(isUniqueViolation(dup, 'listings_one_live_per_property'), true);
  assert.equal(isUniqueViolation({ code: '23505', constraint: 'users_email_key' },
    'listings_one_live_per_property'), false);
  assert.equal(isUniqueViolation({ code: '23503' }, 'listings_one_live_per_property'), false);
  assert.equal(isUniqueViolation(null), false);
  assert.equal(isUniqueViolation(new Error('nope')), false);
});

// ── photos ───────────────────────────────────────────────────────────────────

test('photos: a non-image type is refused', async () => {
  const { listings } = svc();
  await assert.rejects(
    () => listings.addPhoto('listing-1', 'owner-1', { mime: 'application/pdf', bytes: 100 }),
    (err: AppError) => err.status === 400,
  );
});

test('photos: an oversized file is refused', async () => {
  const { listings } = svc();
  await assert.rejects(
    () => listings.addPhoto('listing-1', 'owner-1', { mime: 'image/jpeg', bytes: 20 * 1024 * 1024 }),
    (err: AppError) => err.status === 400 && /larger than/.test(err.message),
  );
});

test('photos: the cap is enforced', async () => {
  const { listings } = svc({ photoCount: MAX_PHOTOS });
  await assert.rejects(
    () => listings.addPhoto('listing-1', 'owner-1', { mime: 'image/jpeg', bytes: 1000 }),
    (err: AppError) => err.status === 409,
  );
});

test('photos: a slot returns a ticket bound to the uploader', async () => {
  const { listings } = svc({ photoCount: 0 });
  const a = await listings.addPhoto('listing-1', 'owner-1', { mime: 'image/jpeg', bytes: 1000 });

  const other = new ListingService(fakeSql({ photoCount: 0 }), 'test-storage-secret');
  const b = await other.addPhoto('listing-1', 'someone-else', { mime: 'image/jpeg', bytes: 1000 });

  assert.notEqual(a.uploadToken, b.uploadToken, 'the ticket must be bound to the user');
  assert.match(a.storageKey, /^listings\/listing-1\//);
});

test('photos: a non-owner cannot add one', async () => {
  const { listings } = svc({ listing: null });
  await assert.rejects(
    () => listings.addPhoto('listing-1', 'someone-else', { mime: 'image/jpeg', bytes: 1000 }),
    (err: AppError) => err.status === 404,
  );
});

test('photos: reorder demands the complete set, exactly once each', async () => {
  const db = fakeSql();
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const inner = db.query.bind(db);
  db.query = async (text: string, params?: readonly unknown[]) => {
    if (text.includes('SELECT id FROM listing_media')) {
      return { rows: ids.map((id) => ({ id })) as never, rowCount: ids.length };
    }
    return inner(text, params);
  };
  const listings = new ListingService(db, 'test-storage-secret');

  // Partial: leaves the rest at positions that may now collide.
  await assert.rejects(
    () => listings.reorderPhotos('listing-1', 'owner-1', [ids[0]!]),
    (err: AppError) => err.status === 400,
  );
  // Repeated id.
  await assert.rejects(
    () => listings.reorderPhotos('listing-1', 'owner-1', [ids[0]!, ids[0]!]),
    (err: AppError) => err.status === 400,
  );
  // Complete and distinct: accepted.
  await listings.reorderPhotos('listing-1', 'owner-1', [ids[1]!, ids[0]!]);
});

test('service: attestation is refused on a human-written description', async () => {
  const db = fakeSql();
  const inner = db.query.bind(db);
  db.query = async (text: string, params?: readonly unknown[]) => {
    // The WHERE clause carries description_source <> 'human', so nothing matches.
    if (text.includes('description_attested_at = now()')) return { rows: [], rowCount: 0 };
    return inner(text, params);
  };
  const listings = new ListingService(db, 'test-storage-secret');
  await assert.rejects(
    () => listings.attestDescription('listing-1', 'owner-1'),
    (err: AppError) => err.status === 404,
  );
});

test('service: the expiry sweep only touches live and paused listings', async () => {
  const { db, listings } = svc();
  await listings.expireStale(10);
  const sweep = db.sent.find((s) => s.text.includes("SET status = 'expired'"))!;
  assert.match(sweep.text, /status IN \('live','paused'\)/);
  assert.match(sweep.text, /expires_at <= now\(\)/);
});

// ── the audit trail on staff decisions ──────────────────────────────────────
//
// The pair that matters is the decision and its record. These assert the
// record exists, carries the before state, and is written with the SAME
// transaction handle as the UPDATE — the audit writer's own tests
// (test/admin.test.ts) prove what that handle then does.

interface Recorded { entry: Record<string, unknown>; tx: Sql }

function auditingSvc(opts: FakeOpts = {}) {
  const db = fakeSql(opts);
  const recorded: Recorded[] = [];
  const listings = new ListingService(db, 'test-storage-secret', {
    audit: { async record(tx: Sql, entry) { recorded.push({ entry: entry as never, tx }); } },
  });
  return { db, listings, recorded };
}

test('audit: a staff approval is recorded with the status it came from', async () => {
  const { listings, recorded } = auditingSvc({
    listing: { ...defaultListing({}), status: 'pending_review' },
  });
  await listings.transition('listing-1', STAFF, 'approve', { ip: '198.51.100.7' });

  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0]!.entry, {
    actorId: 'staff-1', actorRole: 'staff',
    action: 'listing.approve', subject: 'listing', subjectId: 'listing-1',
    before: { status: 'pending_review' },
    after: { status: 'live' },
    ip: '198.51.100.7',
  });
});

test('audit: a rejection records the reason the owner is shown', async () => {
  // Without it the trail says a listing was rejected and cannot say why, which
  // is the one question anyone asks of it later.
  const { listings, recorded } = auditingSvc({
    listing: { ...defaultListing({}), status: 'pending_review' },
  });
  await listings.transition('listing-1', STAFF, 'reject', {
    reason: 'The photos are of a different property.',
  });
  assert.deepEqual(recorded[0]!.entry.after, {
    status: 'rejected', reason: 'The photos are of a different property.',
  });
});

test('audit: an OWNER action is not a staff decision and is not recorded here', async () => {
  // An owner submitting, pausing or resuming their own listing is ordinary
  // use. Recording it would bury the eleven staff decisions a week that the
  // trail exists for under thousands of rows nobody reads.
  const { listings, recorded } = auditingSvc({ photoCount: 3 });
  await listings.transition('listing-1', OWNER, 'submit');
  assert.equal(recorded.length, 0);
});

test('audit: the entry is written on the transaction that made the decision', async () => {
  const { db, listings, recorded } = auditingSvc({
    listing: { ...defaultListing({}), status: 'pending_review' },
  });
  let handedTx: Sql | null = null;
  const realTransaction = db.transaction.bind(db);
  db.transaction = async (fn) => realTransaction((tx) => { handedTx = tx; return fn(tx); });

  await listings.transition('listing-1', STAFF, 'approve');
  assert.ok(handedTx, 'the transition must run in a transaction at all');
  assert.equal(recorded[0]!.tx, handedTx, 'a record on any other handle can commit without the decision');
});
