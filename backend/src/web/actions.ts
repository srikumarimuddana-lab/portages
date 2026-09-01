/**
 * Form handlers — the POST side of every page.
 *
 * Each one does the same four things: read and check the form, call a
 * service, redirect. None of them decides anything. The listing state
 * machine, the message scanner, the role gate and the audit writer all live
 * where they already lived; this file is a second door onto them, not a
 * second implementation.
 *
 * Every handler ends in a redirect, including the failures — see form.ts for
 * why. The result is that refreshing a page can never resend a message,
 * republish a listing, or re-approve something.
 */
import {
  ABSOLUTE_TTL_MS, CSRF_COOKIE, SESSION_COOKIE, serializeCookie, clearCookie,
} from '../lib/session.js';
import { readForm, redirectTo, messageFor, FormError } from './form.js';
import { AMENITIES, PROPERTY_TYPES, ROOM_TYPES } from '../modules/listings/policy.js';
import { explainProblem } from '../modules/ai/listing-builder.js';
import { REPORT_KINDS } from '../modules/trust/reports.js';
import type { App } from '../http/app.js';
import type { ReportKind } from '../modules/trust/reports.js';

/** Where to send someone after a failure, with the reason attached. */
function fail(path: string, err: unknown): Response {
  return redirectTo(path, { error: messageFor(err).message });
}

function sessionCookies(sessionToken: string, csrfToken: string, secure: boolean): string[] {
  return [
    serializeCookie(SESSION_COOKIE, sessionToken, { secure, maxAgeMs: ABSOLUTE_TTL_MS }),
    // Not HttpOnly, on purpose: the page has to echo this value back, either
    // in a hidden field (forms) or a header (the JSON API). That is the
    // "double submit" half — an attacker's site cannot read it cross-origin.
    serializeCookie(CSRF_COOKIE, csrfToken, { secure, maxAgeMs: ABSOLUTE_TTL_MS, httpOnly: false }),
  ];
}

/**
 * Only same-origin paths. A `next` parameter that accepts an absolute URL is
 * an open redirect, and an open redirect on a sign-in page is a phishing
 * primitive: the attacker's link genuinely goes to portage.ca first.
 */
function safeNext(raw: string): string {
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

// ── auth ────────────────────────────────────────────────────────────────────

export async function signInAction(req: Request, app: App): Promise<Response> {
  let next = '/';
  try {
    const { fields } = await readForm(req, app, { requireAuth: false });
    next = safeNext(fields.get('next'));

    const issued = await app.auth.login({
      email: fields.get('email'),
      password: fields.raw('password'),
      ip: 'form',
      userAgent: req.headers.get('user-agent') ?? undefined,
    });
    return redirectTo(next, {
      cookies: sessionCookies(issued.sessionToken, issued.csrfToken, app.secureCookies),
    });
  } catch (err) {
    // Deliberately not "no such account" — AuthService already refuses to
    // distinguish a wrong password from an unknown email, and saying so here
    // would undo that by making the page an account-enumeration oracle.
    return redirectTo(
      `/signin${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`,
      { error: 'That email and password did not match.' },
    );
  }
}

export async function signUpAction(req: Request, app: App): Promise<Response> {
  try {
    const { fields } = await readForm(req, app, { requireAuth: false });
    const issued = await app.auth.signup({
      email: fields.get('email'),
      password: fields.raw('password'),
      ip: 'form',
      userAgent: req.headers.get('user-agent') ?? undefined,
    });
    return redirectTo('/dashboard/listings', {
      notice: 'Welcome to Portage. Check your email to confirm your address.',
      cookies: sessionCookies(issued.sessionToken, issued.csrfToken, app.secureCookies),
    });
  } catch (err) {
    return fail('/signup', err);
  }
}

export async function signOutAction(req: Request, app: App): Promise<Response> {
  try {
    const { sessionId } = await readForm(req, app);
    // The SESSION id, not the user's. logout() revokes a session row by its
    // own id; a user id there would compile, run, revoke nothing, and leave
    // the person signed in while the page told them they were out.
    if (sessionId) await app.auth.logout(sessionId);
  } catch {
    // Signing out must succeed from the user's point of view whatever the
    // server thinks. Clearing the cookies is what actually ends the session
    // in the browser, and that happens either way.
  }
  return redirectTo('/', {
    notice: 'Signed out.',
    cookies: [
      clearCookie(SESSION_COOKIE, app.secureCookies),
      clearCookie(CSRF_COOKIE, app.secureCookies),
    ],
  });
}

// ── email verification ──────────────────────────────────────────────────────

/**
 * POST /account/email/send
 *
 * The rate limits live in OtpService and are per identifier, so pressing this
 * repeatedly is bounded there rather than here. What this adds is the honest
 * message: a resend retires the previous code, and someone who has both in
 * front of them needs to know which one works.
 */
export async function sendEmailCodeAction(req: Request, app: App): Promise<Response> {
  try {
    const { viewer } = await readForm(req, app);
    const out = await app.otpFlows.requestEmailVerification(viewer!.userId);
    return redirectTo('/account/email', {
      notice: out.sent
        ? 'Code sent. It lasts ten minutes, and it replaces any earlier one.'
        : 'That address is already confirmed.',
    });
  } catch (err) {
    return fail('/account/email', err);
  }
}

/** POST /account/email/confirm */
export async function confirmEmailCodeAction(req: Request, app: App): Promise<Response> {
  try {
    const { viewer, fields } = await readForm(req, app);
    const code = fields.get('code');
    if (!/^\d{6}$/.test(code)) throw new FormError('Enter the six digits from the email.');

    await app.otpFlows.confirmEmailVerification(viewer!.userId, code);
    return redirectTo('/account/email', {
      notice: 'Confirmed. Your listings can be published now.',
    });
  } catch (err) {
    return fail('/account/email', err);
  }
}

// ── password reset ──────────────────────────────────────────────────────────

/**
 * POST /forgot-password
 *
 * Always the same answer, whether or not the address is registered. The
 * service is built that way and this must not undo it: a reset form that says
 * "no such account" is an account-enumeration oracle that needs no password
 * and no rate limit to work.
 *
 * The address is carried to the next page so the code entry form is prefilled,
 * which is what makes the flow survive being finished on the phone that got
 * the code rather than the browser that asked.
 */
export async function forgotPasswordAction(req: Request, app: App): Promise<Response> {
  let email = '';
  try {
    const { fields } = await readForm(req, app, { requireAuth: false });
    email = fields.get('email');
    if (!email) throw new FormError('Enter your email address.');

    const out = await app.otpFlows.requestPasswordReset(email);
    const q = new URLSearchParams({ email });
    return redirectTo('/reset-password', { query: q, notice: out.message });
  } catch (err) {
    const q = new URLSearchParams(email ? { email } : {});
    return redirectTo('/forgot-password', { query: q, error: messageFor(err).message });
  }
}

/** POST /reset-password */
export async function resetPasswordAction(req: Request, app: App): Promise<Response> {
  let email = '';
  try {
    const { fields } = await readForm(req, app, { requireAuth: false });
    email = fields.get('email');
    const code = fields.get('code');
    if (!/^\d{6}$/.test(code)) throw new FormError('Enter the six digits from the email.');

    await app.otpFlows.confirmPasswordReset({
      email,
      code,
      // Not trimmed. A password is the one field where leading and trailing
      // space is a character the person chose, and silently removing it locks
      // them out of the account they just set it on.
      newPassword: fields.raw('newPassword'),
    });

    // No session is issued here on purpose. Signing someone in on the strength
    // of a six-digit code, immediately after every other session was cut, is a
    // shortcut worth refusing: they have the new password, so they can use it.
    return redirectTo('/signin', {
      notice: 'Password changed, and every other session signed out. Sign in with the new one.',
    });
  } catch (err) {
    const q = new URLSearchParams(email ? { email } : {});
    return redirectTo('/reset-password', { query: q, error: messageFor(err).message });
  }
}

// ── listings ────────────────────────────────────────────────────────────────

export async function createListingAction(req: Request, app: App): Promise<Response> {
  try {
    const { viewer, fields } = await readForm(req, app);

    const mode = fields.get('mode');
    if (mode !== 'rent' && mode !== 'sale') throw new FormError('Choose rent or sale.');

    const propertyType = fields.get('propertyType');
    if (!PROPERTY_TYPES.includes(propertyType as never)) {
      throw new FormError('Choose a property type.');
    }

    // Dollars in the form, cents in the database. Doing this conversion in the
    // handler rather than the service keeps cents as the only unit any
    // business rule ever sees — the price bands, the search filters and the
    // display formatter all agree because none of them know about dollars.
    const dollars = fields.num('priceDollars');
    if (dollars === undefined || dollars <= 0) throw new FormError('Enter a price.');

    const amenities = fields.all('amenities').filter((a) => AMENITIES.includes(a as never));

    const created = await app.listings.create({
      ownerId: viewer!.userId,
      mode,
      propertyType: propertyType as never,
      priceCents: Math.round(dollars * 100),
      title: fields.get('title'),
      address: {
        addressLine: fields.get('addressLine'),
        city: fields.get('city') || 'Regina',
        province: fields.get('province') || 'SK',
        ...(fields.get('unit') ? { unit: fields.get('unit') } : {}),
      },
      ...(fields.get('description') ? { description: fields.get('description') } : {}),
      ...(fields.int('beds') !== undefined ? { beds: fields.int('beds') } : {}),
      ...(fields.num('baths') !== undefined ? { baths: fields.num('baths') } : {}),
      ...(fields.int('sqft') !== undefined ? { sqft: fields.int('sqft') } : {}),
      ...(amenities.length > 0 ? { amenities } : {}),
    });

    // Straight to the edit page, not the index. A new draft cannot be
    // submitted without at least one photo, and the edit page is the only
    // place a photo can be added — sending the owner to a list and asking them
    // to find their own listing again is a step that exists for no reason.
    return redirectTo(`/dashboard/listings/${created.id}/edit`, {
      notice: 'Saved as a draft. Add photos, then submit it for review.',
    });
  } catch (err) {
    return fail('/dashboard/listings/new', err);
  }
}

/**
 * POST /dashboard/listings/:id/edit
 *
 * Every field the form carries is sent on every save, including the ones the
 * owner left blank — because a blank number field means "I cleared this", and
 * a patch that omits it would silently keep the old value. `undefined` and
 * `null` are different things to `ListingService.update`, and the form is
 * where that distinction has to be made rather than guessed at.
 */
export async function updateListingAction(
  req: Request, listingId: string, app: App,
): Promise<Response> {
  const back = `/dashboard/listings/${listingId}/edit`;
  try {
    const { viewer, fields } = await readForm(req, app);

    const dollars = fields.num('priceDollars');
    if (dollars === undefined || dollars <= 0) throw new FormError('Enter a price.');

    const roomType = fields.get('roomType');
    if (roomType && !ROOM_TYPES.includes(roomType as never)) {
      throw new FormError('Choose a room type from the list.');
    }

    const out = await app.listings.update(listingId, viewer!.userId, {
      title: fields.get('title'),
      priceCents: Math.round(dollars * 100),
      // An empty textarea clears the description; `update` turns '' into null.
      description: fields.get('description'),
      roomType: (roomType || null) as never,
      beds: fields.int('beds') ?? null,
      baths: fields.num('baths') ?? null,
      sqft: fields.int('sqft') ?? null,
      // Unticking every box posts nothing at all, which has to mean "no
      // amenities" rather than "leave them alone" — otherwise an amenity can
      // be added but never removed.
      amenities: fields.all('amenities').filter((a) => AMENITIES.includes(a as never)),
    });

    return redirectTo(back, {
      notice: out.rescanned
        ? 'Saved. Because the wording changed on a live listing, it is back in review.'
        : 'Saved.',
    });
  } catch (err) {
    return fail(back, err);
  }
}

/**
 * POST /dashboard/listings/:id/attest
 *
 * The only thing in the product that satisfies `listings_publish_guard`.
 */
export async function attestListingAction(
  req: Request, listingId: string, app: App,
): Promise<Response> {
  const back = `/dashboard/listings/${listingId}/edit`;
  try {
    const { viewer } = await readForm(req, app);
    await app.listings.attestDescription(listingId, viewer!.userId);
    return redirectTo(back, { notice: 'Confirmed. This listing can now be submitted.' });
  } catch (err) {
    return fail(back, err);
  }
}

/**
 * POST /dashboard/listings/:id/photos/:photoId/move — reordering, as buttons.
 *
 * WHY THIS EXISTS RATHER THAN DRAG-AND-DROP. HTML5 drag-and-drop does not
 * fire on touch. A phone is where these photos were taken and where they will
 * be uploaded, so a drag handle is a control that most of the people using
 * this page do not have. Three buttons per tile work on touch, with a mouse,
 * from the keyboard, and with scripting off — and `cover` is a single tap for
 * the only ordering decision most owners care about.
 *
 * The full order is computed here and handed to `reorderPhotos`, which
 * requires the complete set: a partial reorder leaves the rest at positions
 * that may now collide, and the service is right to refuse it.
 */
export async function movePhotoAction(
  req: Request, listingId: string, photoId: string, app: App,
): Promise<Response> {
  const back = `/dashboard/listings/${listingId}/edit`;
  try {
    const { viewer, fields } = await readForm(req, app);
    const dir = fields.get('dir');
    if (dir !== 'up' && dir !== 'down' && dir !== 'cover') {
      throw new FormError('Unknown move.');
    }

    // Read through the same visibility-checked call every other route uses.
    const listing = await app.listings.get(listingId, {
      userId: viewer!.userId, role: viewer!.role,
    });
    if (!listing.isOwner) throw new FormError('Not found.', 404);

    const ids = listing.photos.map((p) => p.id);
    const at = ids.indexOf(photoId);
    if (at === -1) throw new FormError('Photo not found.', 404);

    const next = reorder(ids, at, dir);
    // A move that changes nothing — "earlier" on the first photo — is not an
    // error worth a red message. Nothing happened, and saying so is enough.
    if (next === null) return redirectTo(back);

    await app.listings.reorderPhotos(listingId, viewer!.userId, next);
    return redirectTo(back, {
      notice: dir === 'cover' ? 'That is now the cover photo.' : 'Photo order saved.',
    });
  } catch (err) {
    return fail(back, err);
  }
}

/** The new order, or null when the move is a no-op. Pure, so it is testable. */
export function reorder(
  ids: readonly string[], at: number, dir: 'up' | 'down' | 'cover',
): string[] | null {
  const id = ids[at];
  if (id === undefined) return null;

  if (dir === 'cover') {
    if (at === 0) return null;
    // Lifted to the front, with everything else keeping its relative order —
    // not swapped with the current cover, which would demote a photo the
    // owner deliberately put second.
    return [id, ...ids.filter((_, i) => i !== at)];
  }

  const to = dir === 'up' ? at - 1 : at + 1;
  if (to < 0 || to >= ids.length) return null;
  const out = [...ids];
  out[at] = out[to]!;
  out[to] = id;
  return out;
}

/** POST /dashboard/listings/:id/photos/:photoId/remove */
export async function removePhotoAction(
  req: Request, listingId: string, photoId: string, app: App,
): Promise<Response> {
  const back = `/dashboard/listings/${listingId}/edit`;
  try {
    const { viewer } = await readForm(req, app);
    await app.listings.removePhoto(listingId, viewer!.userId, photoId);
    return redirectTo(back, { notice: 'Photo removed.' });
  } catch (err) {
    return fail(back, err);
  }
}

/**
 * POST /dashboard/listings/:id/draft — write the description with AI.
 *
 * The JSON route hands the draft back to the caller and lets it decide what to
 * do. A form post has nowhere to put it, so this saves it as the description
 * with `descriptionSource: 'ai_generated'` — which clears any attestation and
 * makes the confirm block appear on the page the owner lands on. They read it,
 * edit it if it is wrong, and confirm it. Nobody else sees it before then.
 *
 * A draft that fails the fact check is NOT saved. Showing an owner copy that
 * claims a garage they do not have, with a warning attached, is how that copy
 * ends up published — the warning is the part people skip.
 */
export async function draftDescriptionAction(
  req: Request, listingId: string, app: App,
): Promise<Response> {
  const back = `/dashboard/listings/${listingId}/edit`;
  try {
    const { viewer } = await readForm(req, app);

    if (!(await app.flags.isEnabled('ai.listing_builder', viewer!.userId))) {
      throw new FormError('Drafting is switched off right now. You can write the description yourself.');
    }
    const budget = await app.aiLimiter.check(viewer!.userId);
    if (!budget.allowed) {
      throw new FormError(
        'You have used the AI drafting budget for today. You can still write the description yourself.',
      );
    }

    // The same read every other listing route uses, so the visibility rules
    // are not reimplemented here. `isOwner` is the ownership check, and a 404
    // keeps a stranger from confirming the listing exists.
    const listing = await app.listings.get(listingId, {
      userId: viewer!.userId, role: viewer!.role,
    });
    if (!listing.isOwner) throw new FormError('Not found.', 404);

    const out = await app.listingBuilder
      .withProvider(app.metered.for({
        actorId: viewer!.userId, subjectType: 'listing', subjectId: listingId,
      }))
      .draft({
        mode: listing.mode,
        propertyType: listing.propertyType,
        roomType: listing.roomType,
        priceCents: listing.priceCents,
        beds: listing.beds,
        baths: listing.baths,
        sqft: listing.sqft,
        amenities: listing.amenities,
        city: listing.address.city,
      });

    if (!out.draft) {
      if (out.problems.length === 0) {
        throw new FormError('Drafting did not work this time. You can write the description yourself.');
      }
      // Carried on the query string so the page can name each problem. Capped
      // at two: the flash is a URL, and one actionable example beats a list
      // nobody reads.
      const q = new URLSearchParams();
      for (const p of out.problems.slice(0, 2)) {
        q.append('problem', `${p.phrase}|${explainProblem(p.kind, p.subject)}`);
      }
      return redirectTo(back, {
        query: q,
        error: 'The draft was not used — it said things your listing does not support.',
      });
    }

    await app.listings.update(listingId, viewer!.userId, {
      description: out.draft.description,
      descriptionSource: 'ai_generated',
    });
    return redirectTo(back, {
      notice: 'Draft written. Read it — it cannot be published until you confirm it is accurate.',
    });
  } catch (err) {
    return fail(back, err);
  }
}

export async function transitionListingAction(
  req: Request, listingId: string, app: App,
): Promise<Response> {
  try {
    const { viewer, fields } = await readForm(req, app);
    const action = fields.get('action');

    // The service owns the state machine and refuses anything it does not
    // allow — including a staff member trying to approve their own listing.
    // This passes the string straight through rather than second-guessing it.
    const out = await app.listings.transition(
      listingId,
      { userId: viewer!.userId, role: viewer!.role },
      action as never,
      { ...(fields.get('reason') ? { reason: fields.get('reason') } : {}), ip: 'form' },
    );

    return redirectTo('/dashboard/listings', {
      notice: out.status === 'pending_review'
        ? 'Submitted. We review new listings before they go public, usually within a day.'
        : `Listing is now ${out.status.replace(/_/g, ' ')}.`,
    });
  } catch (err) {
    // Back to the EDIT page rather than the index, because that is where the
    // reason lives. "This listing is not ready to publish" on a list of
    // listings is a dead end; on the edit page the checklist above the form
    // already says which part is missing.
    return fail(`/dashboard/listings/${listingId}/edit`, err);
  }
}

// ── messaging ───────────────────────────────────────────────────────────────

export async function enquireAction(req: Request, listingId: string, app: App): Promise<Response> {
  try {
    const { viewer, fields } = await readForm(req, app);
    const out = await app.messaging.startThread({
      listingId,
      inquirerId: viewer!.userId,
      body: fields.get('body'),
    });

    // A blocked message is not an error. The sender is told plainly, because
    // the alternative — silence, or a fake success — teaches people that the
    // site swallows messages.
    if (!out.ok) {
      return redirectTo(`/listings/${listingId}`, { error: out.notice });
    }
    return redirectTo(`/messages/${out.threadId}`, {
      notice: 'Sent. You will get an email when they reply.',
    });
  } catch (err) {
    return fail(`/listings/${listingId}`, err);
  }
}

export async function replyAction(req: Request, threadId: string, app: App): Promise<Response> {
  try {
    const { viewer, fields } = await readForm(req, app);
    const out = await app.messaging.reply({
      threadId,
      senderId: viewer!.userId,
      body: fields.get('body'),
    });
    return out.ok
      ? redirectTo(`/messages/${threadId}`)
      : redirectTo(`/messages/${threadId}`, { error: out.notice });
  } catch (err) {
    return fail(`/messages/${threadId}`, err);
  }
}

export async function blockThreadAction(
  req: Request, threadId: string, app: App, unblock = false,
): Promise<Response> {
  try {
    const { viewer } = await readForm(req, app);
    if (unblock) {
      await app.messaging.unblock(threadId, viewer!.userId);
      return redirectTo(`/messages/${threadId}`, { notice: 'Unblocked.' });
    }
    await app.messaging.block(threadId, viewer!.userId);
    return redirectTo(`/messages/${threadId}`, {
      notice: 'Blocked. They cannot write to you about this listing again.',
    });
  } catch (err) {
    return fail(`/messages/${threadId}`, err);
  }
}

// ── reports ─────────────────────────────────────────────────────────────────

export async function reportAction(req: Request, app: App): Promise<Response> {
  const back = new URL(req.url).searchParams.get('from') ?? '/';
  try {
    const { viewer, fields } = await readForm(req, app);
    const kind = fields.get('kind');
    if (!REPORT_KINDS.includes(kind as ReportKind)) throw new FormError('Choose a reason.');

    await app.reports.create({
      reporterId: viewer!.userId,
      subjectType: 'listing',
      subjectId: fields.get('subjectId'),
      kind: kind as ReportKind,
      ...(fields.get('detail') ? { detail: fields.get('detail') } : {}),
    });
    return redirectTo(safeNext(back), {
      notice: 'Thank you. A moderator will look at this.',
    });
  } catch (err) {
    return fail(safeNext(back), err);
  }
}

// ── staff ───────────────────────────────────────────────────────────────────

/**
 * Staff form posts.
 *
 * The role is checked here as well as in the service, and the answer to a
 * caller without it is a 404-shaped redirect rather than a 403 — the same
 * rule the pages and the JSON routes follow, so guessing a URL still teaches
 * a stranger nothing.
 */
function assertStaff(viewer: { role: string } | null): void {
  if (!viewer || (viewer.role !== 'staff' && viewer.role !== 'admin')) {
    throw new FormError('Not found.', 404);
  }
}

export async function decideListingAction(
  req: Request, listingId: string, app: App,
): Promise<Response> {
  try {
    const { viewer, fields } = await readForm(req, app);
    assertStaff(viewer);

    const action = fields.get('action');
    if (action !== 'approve' && action !== 'reject') throw new FormError('Unknown decision.');
    if (action === 'reject' && !fields.get('reason')) {
      throw new FormError('Give a reason. The owner is shown it, and a rejection without one gets resubmitted unchanged.');
    }

    await app.listings.transition(
      listingId,
      { userId: viewer!.userId, role: viewer!.role },
      action,
      { ...(fields.get('reason') ? { reason: fields.get('reason') } : {}), ip: 'form' },
    );
    return redirectTo('/admin/queue', {
      notice: action === 'approve' ? 'Approved and published.' : 'Rejected, and the owner told why.',
    });
  } catch (err) {
    return fail(`/admin/listings/${listingId}`, err);
  }
}

export async function decideMessageAction(
  req: Request, messageId: string, app: App,
): Promise<Response> {
  try {
    const { viewer, fields } = await readForm(req, app);
    assertStaff(viewer);

    const staff = { userId: viewer!.userId, role: viewer!.role as 'staff' | 'admin', ip: 'form' };
    if (fields.get('action') === 'release') {
      await app.messaging.release(messageId, staff);
      return redirectTo('/admin/queue', { notice: 'Released and delivered.' });
    }
    await app.messaging.uphold(messageId, staff);
    return redirectTo('/admin/queue', { notice: 'Block upheld. The message stays withheld.' });
  } catch (err) {
    return fail(`/admin/messages/${messageId}`, err);
  }
}

export async function dismissQueueAction(req: Request, itemId: string, app: App): Promise<Response> {
  try {
    const { viewer } = await readForm(req, app);
    assertStaff(viewer);
    await app.moderation.dismiss(itemId, viewer!.userId);
    return redirectTo('/admin/queue', { notice: 'Closed.' });
  } catch (err) {
    return fail('/admin/queue', err);
  }
}

export async function setFlagAction(req: Request, key: string, app: App): Promise<Response> {
  try {
    const { viewer, fields } = await readForm(req, app);
    // Admin only, not staff — a part-time moderator working the queue must
    // not be able to turn email off for the whole site.
    if (!viewer || viewer.role !== 'admin') throw new FormError('Not found.', 404);

    const enabled = fields.get('enabled') === 'true';
    const flag = await app.flags.set(
      key,
      { enabled, ...(fields.get('note') ? { note: fields.get('note') } : {}) },
      { userId: viewer.userId, role: viewer.role, ip: 'form' },
    );
    return redirectTo('/admin/flags', {
      notice: `${flag.label} is now ${flag.enabled ? 'on' : 'off'}. It takes effect everywhere within about ten seconds.`,
    });
  } catch (err) {
    return fail('/admin/flags', err);
  }
}
