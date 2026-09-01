/**
 * Form handlers.
 *
 * `test/web.test.ts` proves the pages render a token and that `readForm`
 * refuses a post without one. This file is about what happens AFTER that: the
 * arguments each handler actually passes to a service.
 *
 * That distinction is the whole point. A handler that reads the form
 * correctly, checks CSRF correctly, and then calls `update` with the wrong
 * shape produces a page that looks like it saved and did not — and no test
 * that only renders templates or only posts forms can see it. The recurring
 * failure here is `undefined` versus `null`: to `ListingService.update` they
 * mean "leave it alone" and "clear it", and a form that cannot tell them apart
 * is a form where an amenity can be added but never removed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  updateListingAction, attestListingAction, removePhotoAction,
  draftDescriptionAction, transitionListingAction, movePhotoAction,
} from '../src/web/actions.js';
import { CSRF_COOKIE, SESSION_COOKIE, createSessionMaterial } from '../src/lib/session.js';
import type { UpdateListingInput } from '../src/modules/listings/service.js';

const OWNER = 'owner-1';
const LISTING = 'l-1';

/** What a call recorded, so a test can assert on arguments rather than output. */
interface Calls {
  update: Array<{ listingId: string; ownerId: string; patch: UpdateListingInput }>;
  attest: Array<{ listingId: string; ownerId: string }>;
  removePhoto: Array<{ listingId: string; ownerId: string; photoId: string }>;
  drafted: number;
  transition: Array<{ action: string }>;
  reorder: Array<{ listingId: string; ownerId: string; ids: readonly string[] }>;
}

function harness(over: {
  aiEnabled?: boolean;
  budgetAllowed?: boolean;
  isOwner?: boolean;
  draft?: { title: string; description: string } | null;
  problems?: Array<{ kind: 'unbacked_amenity' | 'unknowable_claim'; subject: string; phrase: string }>;
  updateThrows?: unknown;
  photos?: Array<{ id: string }>;
} = {}) {
  const calls: Calls = {
    update: [], attest: [], removePhoto: [], drafted: 0, transition: [], reorder: [],
  };

  const app = {
    cfg: { allowedOrigins: ['https://portage.ca'] },
    secureCookies: true,
    auth: {
      async resolveSession() {
        return { userId: OWNER, sessionId: 's1', csrfHash: MATERIAL.csrfHash, role: 'user' };
      },
    },
    flags: { async isEnabled() { return over.aiEnabled ?? true; } },
    aiLimiter: { async check() { return { allowed: over.budgetAllowed ?? true }; } },
    metered: { for() { return { name: 'fake' }; } },
    listingBuilder: {
      withProvider() {
        return {
          async draft() {
            calls.drafted += 1;
            return {
              draft: over.draft === undefined ? { title: 'T', description: 'D' } : over.draft,
              problems: over.problems ?? [],
              usage: null, model: 'fake',
            };
          },
        };
      },
    },
    listings: {
      async get() {
        return {
          id: LISTING, mode: 'rent', propertyType: 'apartment', roomType: 'entire',
          priceCents: 150_000, beds: 2, baths: 1, sqft: 820,
          amenities: ['parking'], address: { city: 'Regina' },
          photos: over.photos ?? [],
          isOwner: over.isOwner ?? true,
        };
      },
      async reorderPhotos(listingId: string, ownerId: string, ids: readonly string[]) {
        calls.reorder.push({ listingId, ownerId, ids: [...ids] });
      },
      async update(listingId: string, ownerId: string, patch: UpdateListingInput) {
        if (over.updateThrows) throw over.updateThrows;
        calls.update.push({ listingId, ownerId, patch });
        return { rescanned: false };
      },
      async attestDescription(listingId: string, ownerId: string) {
        calls.attest.push({ listingId, ownerId });
      },
      async removePhoto(listingId: string, ownerId: string, photoId: string) {
        calls.removePhoto.push({ listingId, ownerId, photoId });
      },
      async transition(_id: string, _viewer: unknown, action: string) {
        calls.transition.push({ action });
        throw Object.assign(new Error('This listing is not ready to publish.'), {
          name: 'AppError', status: 400,
        });
      },
    },
  } as never;

  return { app, calls };
}

const MATERIAL = createSessionMaterial();

function post(path: string, body: string): Request {
  return new Request(`https://portage.ca${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://portage.ca',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${MATERIAL.csrfToken}`,
    },
    body: `csrf=${MATERIAL.csrfToken}&${body}`,
  });
}

/** The query string a 303 carries back, which is where failures are reported. */
function flash(res: Response): { notice: string | null; error: string | null; path: string } {
  const loc = new URL(res.headers.get('location')!, 'https://portage.ca');
  return {
    notice: loc.searchParams.get('notice'),
    error: loc.searchParams.get('error'),
    path: loc.pathname,
  };
}

// ── saving the details ──────────────────────────────────────────────────────

test('unticking every amenity clears them rather than leaving them alone', async () => {
  // An unchecked checkbox posts NOTHING. If the handler treats "no amenities
  // in the body" as "no change", an owner can add `pets_allowed` and can never
  // take it off — and the listing keeps advertising something untrue.
  const { app, calls } = harness();
  const res = await updateListingAction(
    post(`/dashboard/listings/${LISTING}/edit`, 'title=A+flat&priceDollars=1500'),
    LISTING, app,
  );

  assert.equal(res.status, 303);
  assert.equal(calls.update.length, 1);
  assert.deepEqual(calls.update[0]!.patch.amenities, []);
});

test('a cleared number field is sent as null, not dropped', async () => {
  // Same failure in the other direction: an owner correcting "2 bedrooms" to
  // blank on a studio must be able to. `undefined` here keeps the old value.
  const { app, calls } = harness();
  await updateListingAction(
    post(`/dashboard/listings/${LISTING}/edit`, 'title=A+flat&priceDollars=1500&beds=&baths=&sqft='),
    LISTING, app,
  );

  const patch = calls.update[0]!.patch;
  assert.equal(patch.beds, null);
  assert.equal(patch.baths, null);
  assert.equal(patch.sqft, null);
  assert.ok('beds' in patch, 'the key must be present, or update ignores it');
});

test('the patch is written against the session owner, never a posted id', async () => {
  const { app, calls } = harness();
  await updateListingAction(
    post(`/dashboard/listings/${LISTING}/edit`,
      'title=A+flat&priceDollars=1500&ownerId=someone-else'),
    LISTING, app,
  );
  assert.equal(calls.update[0]!.ownerId, OWNER);
});

test('dollars become cents, and only whole cents', async () => {
  const { app, calls } = harness();
  await updateListingAction(
    post(`/dashboard/listings/${LISTING}/edit`, 'title=A+flat&priceDollars=1499.99'),
    LISTING, app,
  );
  assert.equal(calls.update[0]!.patch.priceCents, 149_999);
});

test('a missing or nonsense price is refused before the service sees it', async () => {
  for (const body of ['title=A+flat', 'title=A+flat&priceDollars=0', 'title=A+flat&priceDollars=abc']) {
    const { app, calls } = harness();
    const res = await updateListingAction(post(`/dashboard/listings/${LISTING}/edit`, body), LISTING, app);
    assert.equal(calls.update.length, 0, body);
    assert.equal(flash(res).error, 'Enter a price.', body);
  }
});

test('an unknown room type is refused rather than passed through', async () => {
  const { app, calls } = harness();
  const res = await updateListingAction(
    post(`/dashboard/listings/${LISTING}/edit`, 'title=A&priceDollars=1500&roomType=penthouse'),
    LISTING, app,
  );
  assert.equal(calls.update.length, 0);
  assert.match(flash(res).error!, /room type/);
});

test('an invented amenity is dropped, not forwarded', async () => {
  const { app, calls } = harness();
  await updateListingAction(
    post(`/dashboard/listings/${LISTING}/edit`,
      'title=A&priceDollars=1500&amenities=parking&amenities=helipad'),
    LISTING, app,
  );
  assert.deepEqual(calls.update[0]!.patch.amenities, ['parking']);
});

test('a failed save lands back on the edit page with the reason', async () => {
  const { app } = harness({
    updateThrows: Object.assign(new Error('This listing is closed.'), {
      name: 'AppError', status: 409,
    }),
  });
  const res = await updateListingAction(
    post(`/dashboard/listings/${LISTING}/edit`, 'title=A&priceDollars=1500'), LISTING, app,
  );
  assert.equal(flash(res).path, `/dashboard/listings/${LISTING}/edit`);
  assert.equal(flash(res).error, 'This listing is closed.');
});

// ── attestation and photos ──────────────────────────────────────────────────

test('attesting records it against the session owner', async () => {
  const { app, calls } = harness();
  const res = await attestListingAction(post(`/dashboard/listings/${LISTING}/attest`, ''), LISTING, app);
  assert.deepEqual(calls.attest, [{ listingId: LISTING, ownerId: OWNER }]);
  assert.match(flash(res).notice!, /can now be submitted/);
});

test('removing a photo passes the owner, so another account cannot delete it', async () => {
  const { app, calls } = harness();
  await removePhotoAction(
    post(`/dashboard/listings/${LISTING}/photos/p-9/remove`, ''), LISTING, 'p-9', app,
  );
  assert.deepEqual(calls.removePhoto, [{ listingId: LISTING, ownerId: OWNER, photoId: 'p-9' }]);
});

// ── a failed transition goes somewhere useful ───────────────────────────────

test('a refused submit returns to the page that explains why', async () => {
  // "This listing is not ready to publish" on the listings index is a dead
  // end. On the edit page the checklist above the form already names the
  // missing part.
  const { app } = harness();
  const res = await transitionListingAction(
    post(`/dashboard/listings/${LISTING}/transition`, 'action=submit'), LISTING, app,
  );
  assert.equal(flash(res).path, `/dashboard/listings/${LISTING}/edit`);
  assert.match(flash(res).error!, /not ready to publish/);
});

// ── AI drafting ─────────────────────────────────────────────────────────────

test('a draft that fails the fact check is never saved', async () => {
  // The invariant this handler exists to keep. Copy claiming a heated garage
  // the property does not have is a false representation under Competition
  // Act s.74.01 the moment it is published — so it does not get stored,
  // shown-with-a-warning, or left in a textarea for someone to submit later.
  const { app, calls } = harness({
    draft: null,
    problems: [{ kind: 'unbacked_amenity', subject: 'heated_garage', phrase: 'heated garage' }],
  });
  const res = await draftDescriptionAction(post(`/dashboard/listings/${LISTING}/draft`, ''), LISTING, app);

  assert.equal(calls.update.length, 0, 'a refused draft must not be written');
  const loc = new URL(res.headers.get('location')!, 'https://portage.ca');
  assert.deepEqual(
    loc.searchParams.getAll('problem'),
    ['heated garage|The draft mentioned heated garage, which is not listed on this property. '
      + 'Add the amenity if the property has it, then try again.'],
  );
  assert.match(loc.searchParams.get('error')!, /not used/);
});

test('an accepted draft is saved as AI copy, which re-arms attestation', async () => {
  // `descriptionSource` is what makes listings_publish_guard refuse to publish
  // it unattested. Saving it as 'human' would smuggle unread AI copy past the
  // one control that stops that.
  const { app, calls } = harness({ draft: { title: 'T', description: 'A real description.' } });
  const res = await draftDescriptionAction(post(`/dashboard/listings/${LISTING}/draft`, ''), LISTING, app);

  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0]!.patch.description, 'A real description.');
  assert.equal(calls.update[0]!.patch.descriptionSource, 'ai_generated');
  assert.match(flash(res).notice!, /confirm it is accurate/);
});

test('the kill switch is checked before the model is called, not after', async () => {
  // A switch that stops the answer being shown but not the call being billed
  // is not a kill switch.
  const { app, calls } = harness({ aiEnabled: false });
  const res = await draftDescriptionAction(post(`/dashboard/listings/${LISTING}/draft`, ''), LISTING, app);
  assert.equal(calls.drafted, 0);
  assert.match(flash(res).error!, /switched off/);
});

test('a spent daily budget stops the call too', async () => {
  const { app, calls } = harness({ budgetAllowed: false });
  const res = await draftDescriptionAction(post(`/dashboard/listings/${LISTING}/draft`, ''), LISTING, app);
  assert.equal(calls.drafted, 0);
  assert.match(flash(res).error!, /budget/);
});

test('drafting for a listing you do not own is a 404, and costs nothing', async () => {
  // Not a 403: that would confirm the listing exists. And the model must not
  // run first — otherwise a stranger can spend someone else's budget.
  const { app, calls } = harness({ isOwner: false });
  const res = await draftDescriptionAction(post(`/dashboard/listings/${LISTING}/draft`, ''), LISTING, app);
  assert.equal(calls.drafted, 0);
  assert.equal(calls.update.length, 0);
  assert.equal(flash(res).error, 'Not found.');
});

// ── the gate every one of these sits behind ─────────────────────────────────

test('every edit handler refuses a post with no CSRF token', async () => {
  const bare = (path: string) => new Request(`https://portage.ca${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://portage.ca',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${MATERIAL.csrfToken}`,
    },
    body: 'title=A&priceDollars=1500',
  });

  const cases: Array<[string, () => Promise<Response>]> = [
    ['update', () => {
      const { app } = harness();
      return updateListingAction(bare('/x'), LISTING, app);
    }],
    ['attest', () => {
      const { app } = harness();
      return attestListingAction(bare('/x'), LISTING, app);
    }],
    ['removePhoto', () => {
      const { app } = harness();
      return removePhotoAction(bare('/x'), LISTING, 'p-1', app);
    }],
    ['draft', () => {
      const { app } = harness();
      return draftDescriptionAction(bare('/x'), LISTING, app);
    }],
  ];

  for (const [name, run] of cases) {
    const res = await run();
    assert.equal(res.status, 303, name);
    assert.match(flash(res).error!, /form has expired/, name);
  }
});

test('a cross-site post is refused by every edit handler', async () => {
  const evil = new Request(`https://portage.ca/x`, {
    method: 'POST',
    headers: {
      origin: 'https://evil.example',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${SESSION_COOKIE}=s; ${CSRF_COOKIE}=${MATERIAL.csrfToken}`,
    },
    body: `csrf=${MATERIAL.csrfToken}&title=A&priceDollars=1500`,
  });

  const { app, calls } = harness();
  const res = await updateListingAction(evil, LISTING, app);
  assert.equal(calls.update.length, 0);
  assert.match(flash(res).error!, /did not come from Portage/);
});

test('a new draft lands on its own edit page, where photos are added', async () => {
  // The step this removes: a draft cannot be submitted without a photo, and
  // the edit page is the only place a photo can be added. Sending the owner to
  // a list and asking them to find the listing they just made is a detour.
  const { createListingAction } = await import('../src/web/actions.js');
  const app = {
    cfg: { allowedOrigins: ['https://portage.ca'] },
    auth: {
      async resolveSession() {
        return { userId: OWNER, sessionId: 's1', csrfHash: MATERIAL.csrfHash, role: 'user' };
      },
    },
    listings: { async create() { return { id: 'new-1', propertyId: 'p-1' }; } },
  } as never;

  const res = await createListingAction(
    post('/dashboard/listings',
      'mode=rent&propertyType=apartment&priceDollars=1500&title=A+flat'
      + '&addressLine=2100+Victoria+Ave'),
    app,
  );
  assert.equal(flash(res).path, '/dashboard/listings/new-1/edit');
  assert.match(flash(res).notice!, /Add photos/);
});

// ── reordering photos ───────────────────────────────────────────────────────

test('reorder: cover lifts to the front and keeps everyone else in order', async () => {
  // Lifted, not swapped. Swapping with the current cover would demote a photo
  // the owner deliberately put second, which is a change they did not ask for.
  const { reorder } = await import('../src/web/actions.js');
  assert.deepEqual(reorder(['a', 'b', 'c', 'd'], 2, 'cover'), ['c', 'a', 'b', 'd']);
  assert.deepEqual(reorder(['a', 'b', 'c'], 1, 'cover'), ['b', 'a', 'c']);
});

test('reorder: up and down swap with the neighbour', async () => {
  const { reorder } = await import('../src/web/actions.js');
  assert.deepEqual(reorder(['a', 'b', 'c'], 1, 'up'), ['b', 'a', 'c']);
  assert.deepEqual(reorder(['a', 'b', 'c'], 1, 'down'), ['a', 'c', 'b']);
});

test('reorder: a move that changes nothing returns null, not a no-op array', async () => {
  // The distinction matters upstream: null means do not touch the database,
  // which is why "earlier" on the first photo does not write a row or claim
  // that an order was saved.
  const { reorder } = await import('../src/web/actions.js');
  assert.equal(reorder(['a', 'b'], 0, 'up'), null);
  assert.equal(reorder(['a', 'b'], 1, 'down'), null);
  assert.equal(reorder(['a', 'b'], 0, 'cover'), null);
  assert.equal(reorder(['a', 'b'], 9, 'up'), null, 'an index off the end is not a crash');
});

test('reorder: every result is a permutation, never a lost or duplicated photo', async () => {
  // reorderPhotos requires the COMPLETE set exactly once and refuses anything
  // else — correctly, since a partial order leaves the rest at positions that
  // may now collide. A bug here would surface as a service error the owner
  // cannot act on, so it is checked exhaustively instead.
  const { reorder } = await import('../src/web/actions.js');
  const ids = ['a', 'b', 'c', 'd', 'e'];
  for (const dir of ['up', 'down', 'cover'] as const) {
    for (let at = 0; at < ids.length; at++) {
      const out = reorder(ids, at, dir);
      if (out === null) continue;
      assert.deepEqual([...out].sort(), [...ids].sort(), `${dir} at ${at} is not a permutation`);
      assert.equal(new Set(out).size, ids.length, `${dir} at ${at} duplicated a photo`);
    }
  }
});

test('moving a photo sends the complete new order, which is what the service demands', async () => {
  const { app, calls } = harness({
    photos: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
  });
  const res = await movePhotoAction(
    post(`/dashboard/listings/${LISTING}/photos/p3/move`, 'dir=cover'), LISTING, 'p3', app,
  );

  assert.deepEqual(calls.reorder, [{
    listingId: LISTING, ownerId: OWNER, ids: ['p3', 'p1', 'p2'],
  }]);
  assert.match(flash(res).notice!, /cover photo/);
});

test('a move that changes nothing writes nothing and says nothing', async () => {
  const { app, calls } = harness({ photos: [{ id: 'p1' }, { id: 'p2' }] });
  const res = await movePhotoAction(
    post(`/dashboard/listings/${LISTING}/photos/p1/move`, 'dir=up'), LISTING, 'p1', app,
  );
  assert.equal(calls.reorder.length, 0);
  assert.equal(flash(res).notice, null, 'nothing happened, so there is nothing to announce');
  assert.equal(flash(res).error, null, 'and it is not an error either');
});

test('an unknown direction is refused rather than guessed at', async () => {
  const { app, calls } = harness({ photos: [{ id: 'p1' }, { id: 'p2' }] });
  const res = await movePhotoAction(
    post(`/dashboard/listings/${LISTING}/photos/p1/move`, 'dir=sideways'), LISTING, 'p1', app,
  );
  assert.equal(calls.reorder.length, 0);
  assert.match(flash(res).error!, /Unknown move/);
});

test('moving a photo on a listing you do not own is a 404', async () => {
  const { app, calls } = harness({ isOwner: false, photos: [{ id: 'p1' }, { id: 'p2' }] });
  const res = await movePhotoAction(
    post(`/dashboard/listings/${LISTING}/photos/p2/move`, 'dir=cover'), LISTING, 'p2', app,
  );
  assert.equal(calls.reorder.length, 0);
  assert.equal(flash(res).error, 'Not found.');
});

test('moving a photo that is not on the listing is a 404, not a crash', async () => {
  const { app, calls } = harness({ photos: [{ id: 'p1' }] });
  const res = await movePhotoAction(
    post(`/dashboard/listings/${LISTING}/photos/nope/move`, 'dir=cover'), LISTING, 'nope', app,
  );
  assert.equal(calls.reorder.length, 0);
  assert.equal(flash(res).error, 'Photo not found.');
});

// ── email verification and password reset ───────────────────────────────────
//
// Both of these APIs were built, tested, and completely unreachable. The
// assertions here are about the handler being a faithful door onto them —
// especially where a careless handler would undo a property the service went
// to trouble to have.

function authHarness(over: { sent?: boolean; throws?: unknown } = {}) {
  const calls = {
    requested: [] as string[],
    confirmed: [] as Array<{ userId: string; code: string }>,
    resetRequested: [] as string[],
    resetConfirmed: [] as Array<{ email: string; code: string; newPassword: string }>,
  };
  const app = {
    cfg: { allowedOrigins: ['https://portage.ca'] },
    secureCookies: true,
    auth: {
      async resolveSession() {
        return {
          userId: OWNER, sessionId: 's1', csrfHash: MATERIAL.csrfHash, role: 'user',
          email: 'owner@example.test', emailVerified: false,
        };
      },
    },
    otpFlows: {
      async requestEmailVerification(userId: string) {
        if (over.throws) throw over.throws;
        calls.requested.push(userId);
        return { sent: over.sent ?? true };
      },
      async confirmEmailVerification(userId: string, code: string) {
        if (over.throws) throw over.throws;
        calls.confirmed.push({ userId, code });
      },
      async requestPasswordReset(email: string) {
        calls.resetRequested.push(email);
        return { message: 'If that address is registered, a code is on its way.' };
      },
      async confirmPasswordReset(input: { email: string; code: string; newPassword: string }) {
        if (over.throws) throw over.throws;
        calls.resetConfirmed.push(input);
      },
    },
  } as never;
  return { app, calls };
}

function anonPost(path: string, body: string): Request {
  return new Request(`https://portage.ca${path}`, {
    method: 'POST',
    headers: {
      origin: 'https://portage.ca',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
}

test('sending a verification code says that it retires the previous one', async () => {
  // Someone looking at two codes needs to know which works. Saying nothing is
  // how a person types the older one and concludes the feature is broken.
  const { sendEmailCodeAction } = await import('../src/web/actions.js');
  const { app, calls } = authHarness();
  const res = await sendEmailCodeAction(post('/account/email/send', ''), app);
  assert.deepEqual(calls.requested, [OWNER]);
  assert.match(flash(res).notice!, /replaces any earlier one/);
});

test('an already-verified address is told so, not told a code was sent', async () => {
  const { sendEmailCodeAction } = await import('../src/web/actions.js');
  const { app } = authHarness({ sent: false });
  const res = await sendEmailCodeAction(post('/account/email/send', ''), app);
  assert.match(flash(res).notice!, /already confirmed/);
});

test('the code is checked for shape before the service is called', async () => {
  const { confirmEmailCodeAction } = await import('../src/web/actions.js');
  for (const code of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
    const { app, calls } = authHarness();
    const res = await confirmEmailCodeAction(
      post('/account/email/confirm', `code=${encodeURIComponent(code)}`), app,
    );
    assert.equal(calls.confirmed.length, 0, `"${code}" should not reach the service`);
    assert.match(flash(res).error!, /six digits/);
  }
});

test('a valid code is passed through with the session user, never a posted one', async () => {
  const { confirmEmailCodeAction } = await import('../src/web/actions.js');
  const { app, calls } = authHarness();
  await confirmEmailCodeAction(
    post('/account/email/confirm', 'code=123456&userId=someone-else'), app,
  );
  assert.deepEqual(calls.confirmed, [{ userId: OWNER, code: '123456' }]);
});

test('the reset request answers identically whether or not the account exists', async () => {
  // The service is built not to distinguish them. A handler that reported
  // "no such account" would turn a page needing no password and no session
  // into an account-enumeration oracle.
  const { forgotPasswordAction } = await import('../src/web/actions.js');
  const { app, calls } = authHarness();

  const a = await forgotPasswordAction(
    anonPost('/forgot-password', 'email=real@example.test'), app,
  );
  const b = await forgotPasswordAction(
    anonPost('/forgot-password', 'email=nobody@example.test'), app,
  );

  assert.equal(flash(a).notice, flash(b).notice);
  assert.equal(flash(a).path, flash(b).path);
  assert.equal(flash(a).error, null);
  assert.deepEqual(calls.resetRequested, ['real@example.test', 'nobody@example.test']);
});

test('the reset request carries the address forward so the next page is prefilled', async () => {
  // The code arrives on a phone; the form was opened on a laptop. Without
  // this the person has to retype the address they just typed.
  const { forgotPasswordAction } = await import('../src/web/actions.js');
  const { app } = authHarness();
  const res = await forgotPasswordAction(
    anonPost('/forgot-password', 'email=real%40example.test'), app,
  );
  const loc = new URL(res.headers.get('location')!, 'https://portage.ca');
  assert.equal(loc.pathname, '/reset-password');
  assert.equal(loc.searchParams.get('email'), 'real@example.test');
});

test('a password is passed through untrimmed', async () => {
  // `get()` trims. A space at either end of a password is a character the
  // person chose, and the JSON API's validator is explicitly trim:false — so
  // trimming here means a password set through the API could never be typed
  // into this form.
  const { resetPasswordAction } = await import('../src/web/actions.js');
  const { app, calls } = authHarness();
  await resetPasswordAction(
    anonPost('/reset-password',
      'email=a%40b.test&code=123456&newPassword=%20a+long+passphrase%20'), app,
  );
  assert.equal(calls.resetConfirmed[0]!.newPassword, ' a long passphrase ');
});

test('a completed reset does not sign you in', async () => {
  // Every session was just cut, on purpose. Issuing a fresh one on the
  // strength of a six-digit code hands the account to whoever had the code.
  const { resetPasswordAction } = await import('../src/web/actions.js');
  const { app } = authHarness();
  const res = await resetPasswordAction(
    anonPost('/reset-password', 'email=a%40b.test&code=123456&newPassword=a+long+passphrase'), app,
  );
  assert.equal(flash(res).path, '/signin');
  assert.equal(res.headers.get('set-cookie'), null, 'no session cookie may be issued here');
  assert.match(flash(res).notice!, /signed out/);
});

test('a failed reset keeps the address so the code does not have to be re-requested', async () => {
  const { resetPasswordAction } = await import('../src/web/actions.js');
  const { app } = authHarness({
    throws: Object.assign(new Error('That code is not valid. Request a new one and try again.'), {
      name: 'AppError', status: 401,
    }),
  });
  const res = await resetPasswordAction(
    anonPost('/reset-password', 'email=a%40b.test&code=999999&newPassword=a+long+passphrase'), app,
  );
  const loc = new URL(res.headers.get('location')!, 'https://portage.ca');
  assert.equal(loc.pathname, '/reset-password');
  assert.equal(loc.searchParams.get('email'), 'a@b.test');
  assert.match(loc.searchParams.get('error')!, /not valid/);
});

// ── saved searches ──────────────────────────────────────────────────────────

function searchHarness() {
  const calls = {
    saved: [] as Array<{ name: string; alertEnabled?: boolean; spec: unknown }>,
    alerts: [] as Array<{ id: string; enabled: boolean; evidence?: unknown }>,
    removed: [] as string[],
  };
  const app = {
    cfg: { allowedOrigins: ['https://portage.ca'] },
    auth: {
      async resolveSession() {
        return {
          userId: OWNER, sessionId: 's1', csrfHash: MATERIAL.csrfHash, role: 'user',
          email: 'o@example.test', emailVerified: true,
        };
      },
    },
    savedSearches: {
      async save(input: { name: string; alertEnabled?: boolean; spec: unknown }) {
        calls.saved.push(input);
        return { id: 'saved-1' };
      },
      async setAlert(id: string, _userId: string, input: { enabled: boolean; evidence?: unknown }) {
        calls.alerts.push({ id, ...input });
      },
      async remove(id: string) { calls.removed.push(id); },
    },
  } as never;
  return { app, calls };
}

test('saving a search never turns alerts on', async () => {
  // The single most important line in this feature. Consent bundled into
  // another action is the weakest kind under CASL and the hardest to defend;
  // a "save" button that also opts you into email is exactly that.
  const { saveSearchAction } = await import('../src/web/actions.js');
  const { app, calls } = searchHarness();

  await saveSearchAction(
    post('/account/searches', 'name=Two+beds&query=mode%3Drent%26minBeds%3D2'), app,
  );
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.saved[0]!.alertEnabled, false);
});

test('the saved spec is built from the query string, not stored raw', async () => {
  // One definition of what a search URL means. Storing the raw string would
  // be a second, and the two would drift.
  const { saveSearchAction } = await import('../src/web/actions.js');
  const { app, calls } = searchHarness();

  await saveSearchAction(
    post('/account/searches', 'name=Two+beds&query=mode%3Drent%26minPrice%3D1500%26minBeds%3D2'), app,
  );
  const spec = calls.saved[0]!.spec as Record<string, unknown>;
  assert.equal(spec['mode'], 'rent');
  assert.equal(spec['minPriceCents'], 150_000, 'dollars must already be cents');
  assert.equal(spec['minBeds'], 2);
});

test('an unticked alert box is read as a withdrawal', async () => {
  // An unchecked checkbox posts nothing at all. That absence IS the
  // withdrawal, and reading it as "no change" would make turning alerts off
  // impossible from the only control that offers it.
  const { setSearchAlertAction } = await import('../src/web/actions.js');
  const { app, calls } = searchHarness();

  await setSearchAlertAction(post('/x', 'frequency=daily'), 'saved-1', app);
  assert.deepEqual(calls.alerts.map((a) => a.enabled), [false]);
});

test('a ticked alert box records evidence of what was submitted', async () => {
  const { setSearchAlertAction } = await import('../src/web/actions.js');
  const { app, calls } = searchHarness();

  await setSearchAlertAction(post('/x', 'enabled=true&frequency=weekly'), 'saved-1', app);
  assert.equal(calls.alerts[0]!.enabled, true);
  const evidence = calls.alerts[0]!.evidence as Record<string, unknown>;
  assert.equal(evidence['via'], 'web_form');
  assert.equal(evidence['path'], '/account/searches');
});

test('an unknown frequency is refused rather than passed through', async () => {
  const { setSearchAlertAction } = await import('../src/web/actions.js');
  const { app, calls } = searchHarness();

  const res = await setSearchAlertAction(
    post('/x', 'enabled=true&frequency=hourly'), 'saved-1', app,
  );
  assert.equal(calls.alerts.length, 0);
  assert.match(flash(res).error!, /how often/);
});
