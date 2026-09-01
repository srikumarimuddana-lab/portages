/**
 * The signed-in pages: sign-up, the owner's listings, and the inbox.
 *
 * Same rules as pages.ts — every value goes through `html`, every page is a
 * pure function of its data, and nothing here decides anything a module has
 * not already decided.
 *
 * One thing worth noticing across all three: the actions a page offers come
 * from the SERVICE, not from the template's own idea of what should be
 * possible. `ListingView.actions` is computed by the listing state machine, so
 * the buttons a listing shows and the transitions the API will accept cannot
 * disagree. A template that decides for itself which buttons to draw is how
 * you get a "Publish" button that returns 409.
 */
import { html, type Html } from './html.js';
import { page, money, facts, csrfField, type Flash, type Viewer } from './layout.js';
import { iconSprite } from './icons.js';
import { amenityPicker } from './pages-parts.js';
import type { AmenityGroup } from '../modules/listings/policy.js';
import type { ListingView } from '../modules/listings/service.js';
import type { ThreadSummary, ThreadDetail } from '../modules/messaging/service.js';

// ── sign up ─────────────────────────────────────────────────────────────────

export function signUpPage(opts: Flash = {}): string {
  return page(
    { title: 'Create an account', viewer: null, path: '/signup', notice: opts.notice, error: opts.error },
    html`
<div class="wrap" style="max-width:420px;padding:52px 20px">
  <h1>Create an account</h1>
  <p class="muted" style="margin-top:-4px">
    Free to browse, free to message, free to list. There is no paid tier.
  </p>
  ${opts.error ? html`<p class="notice notice-warn">${opts.error}</p>` : null}
  <form method="post" action="/signup" class="stack">
    <div class="field">
      <label for="email">Email</label>
      <input id="email" type="email" name="email" required autocomplete="email">
    </div>
    <div class="field">
      <label for="pw">Password</label>
      <input id="pw" type="password" name="password" required
             autocomplete="new-password" minlength="12">
      <p class="small muted" style="margin:6px 0 0">
        At least 12 characters. Longer is better than complicated.
      </p>
    </div>
    <button class="btn btn-primary" type="submit" style="width:100%">Create account</button>
  </form>
  <p class="small muted" style="margin-top:18px">
    Already have one? <a href="/signin">Sign in</a>.
  </p>
</div>`,
  );
}

// ── owner: my listings ──────────────────────────────────────────────────────

/**
 * What each status means to the person who owns it.
 *
 * Written for an owner, not for the state machine. "pending_review" is
 * accurate and tells them nothing about what to do or how long it takes.
 */
const STATUS_COPY: Record<string, { label: string; cls: string; note: string }> = {
  draft: {
    label: 'Draft', cls: 'badge-draft',
    note: 'Only you can see this. Submit it when you are ready.',
  },
  pending_review: {
    label: 'In review', cls: 'badge-review',
    note: 'We check every new listing before it goes public. Usually within a day.',
  },
  live: { label: 'Live', cls: 'badge-live', note: 'Anyone can find this listing.' },
  paused: { label: 'Paused', cls: 'badge-draft', note: 'Hidden from search. Resume it any time.' },
  rented: { label: 'Rented', cls: 'badge-draft', note: 'Closed. Nobody can enquire.' },
  sold: { label: 'Sold', cls: 'badge-draft', note: 'Closed. Nobody can enquire.' },
  expired: {
    label: 'Expired', cls: 'badge-draft',
    note: 'Listings expire so search stays honest. Resubmit to bring it back.',
  },
  rejected: {
    label: 'Needs changes', cls: 'badge-warn',
    note: 'A moderator asked for changes before this can go live.',
  },
};

/** Human labels for the actions the state machine allows. */
const ACTION_COPY: Record<string, string> = {
  submit: 'Submit for review',
  publish: 'Publish',
  approve: 'Approve',
  reject: 'Reject',
  pause: 'Pause',
  resume: 'Resume',
  close: 'Mark as closed',
  archive: 'Archive',
};

export function ownerListingsPage(opts: Flash & {
  viewer: Viewer;
  listings: ListingView[];
}): string {
  return page(
    { title: 'My listings', viewer: opts.viewer, path: '/dashboard/listings' , notice: opts.notice, error: opts.error },
    html`
<div class="wrap" style="padding:26px 20px 60px">
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:18px">
    <h1 style="margin:0">My listings</h1>
    <a class="btn btn-primary" href="/dashboard/listings/new" style="margin-left:auto">
      Post a listing
    </a>
  </div>

  ${opts.listings.length === 0
    ? html`<div class="empty">
             <p>You have not posted a listing yet.</p>
             <p class="small">It is free, and it stays free.</p>
             <a class="btn btn-primary" href="/dashboard/listings/new">Post your first listing</a>
           </div>`
    : html`<div class="stack">${opts.listings.map((l) => ownerRow(l, opts.viewer))}</div>`}
</div>`,
  );
}

function ownerRow(l: ListingView, viewer: Viewer): Html {
  const s = STATUS_COPY[l.status] ?? { label: l.status, cls: 'badge-draft', note: '' };
  return html`
<div class="card" style="flex-direction:row;align-items:stretch">
  <div class="ph" style="width:150px;flex:0 0 150px;aspect-ratio:auto">
    ${l.photos.length > 0 ? html`<img src="/media/${l.photos[0]!.storageKey}" alt=""
      style="width:100%;height:100%;object-fit:cover">` : html`No photo`}
  </div>
  <div class="body" style="flex:1;display:flex;flex-direction:column">
    <div style="display:flex;align-items:center;gap:10px">
      <span class="badge ${s.cls}">${s.label}</span>
      ${l.descriptionSource !== 'human' && !l.descriptionAttested
        ? html`<span class="badge badge-warn">Needs your confirmation</span>`
        : null}
      <span class="price" style="margin-left:auto">
        ${money(l.priceCents)}${l.mode === 'rent' ? html`<small> /mo</small>` : null}
      </span>
    </div>
    <div class="addr" style="margin-top:6px">${l.address.addressLine}</div>
    <div class="facts">${facts(l)}</div>
    <p class="small muted" style="margin:8px 0 0">${s.note}</p>

    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <a class="btn btn-sm" href="/listings/${l.id}">View</a>
      <a class="btn btn-sm" href="/dashboard/listings/${l.id}/edit">Edit</a>
      ${/* The buttons come from the state machine, not from this template.
            A template that decides for itself which transitions to offer is
            how a "Publish" button that returns 409 gets shipped. */
        (l.actions ?? []).map((a) => html`
        <form method="post" action="/dashboard/listings/${l.id}/transition" style="display:inline">
          ${csrfField(viewer)}
          <input type="hidden" name="action" value="${a}">
          <button class="btn btn-sm${a === 'submit' ? ' btn-primary' : ''}" type="submit">
            ${ACTION_COPY[a] ?? a}
          </button>
        </form>`)}
    </div>
  </div>
</div>`;
}

// ── owner: new listing ──────────────────────────────────────────────────────

export function newListingPage(opts: Flash & {
  viewer: Viewer;
  propertyTypes: readonly string[];
  amenityGroups: readonly AmenityGroup[];
  aiEnabled: boolean;
  error?: string | null;
}): string {
  return page(
    { title: 'Post a listing', viewer: opts.viewer, path: '/dashboard/listings/new' , notice: opts.notice, error: opts.error },
    html`
${iconSprite()}
<div class="wrap" style="max-width:680px;padding:30px 20px 60px">
  <h1>Post a listing</h1>
  <p class="muted" style="margin-top:-4px">
    No fee, now or later. We review every listing before it goes public.
  </p>
  ${opts.error ? html`<p class="notice notice-warn">${opts.error}</p>` : null}

  <form method="post" action="/dashboard/listings" class="stack" style="margin-top:22px">
    ${csrfField(opts.viewer)}
    <div class="field">
      <label for="mode">Listing type</label>
      <select id="mode" name="mode" required>
        <option value="rent">For rent</option>
        <option value="sale">For sale</option>
      </select>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px">
      <div class="field">
        <label for="propertyType">Property type</label>
        <select id="propertyType" name="propertyType" required>
          ${opts.propertyTypes.map((t) =>
            html`<option value="${t}">${t.replace(/_/g, ' ')}</option>`)}
        </select>
      </div>
      <div class="field">
        <label for="price">Price</label>
        <input id="price" type="number" name="priceDollars" min="1" required
               placeholder="1500">
        <p class="small muted" style="margin:6px 0 0">Per month for a rental.</p>
      </div>
    </div>

    <div class="field">
      <label for="addressLine">Street address</label>
      <input id="addressLine" type="text" name="addressLine" required
             placeholder="2100 Victoria Ave" autocomplete="off">
    </div>

    ${/* auto-fit, not four fixed columns: at 390px those are 77px each, which
          is narrower than the word "Square feet" and leaves an input nobody
          can read what they typed into. */ null}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:14px">
      ${numField('unit', 'Unit', 'text', '3B')}
      ${numField('beds', 'Bedrooms', 'number', '2')}
      ${numField('baths', 'Bathrooms', 'number', '1')}
      ${numField('sqft', 'Square feet', 'number', '820')}
    </div>

    <div class="field">
      <label for="title">Title</label>
      <input id="title" type="text" name="title" required maxlength="120"
             placeholder="Bright two bedroom in Cathedral">
    </div>

    <div class="field">
      <label for="description">Description</label>
      <textarea id="description" name="description" rows="7"
        placeholder="What is it like to live here?"></textarea>
      ${opts.aiEnabled
        ? html`<p class="small muted" style="margin:6px 0 0">
                 Stuck? Save this as a draft and we can write a first version from
                 the facts above — you read it and confirm it before it goes live.
               </p>`
        : null}
    </div>

    ${/* Nothing is ticked yet on a new listing, so the picker starts empty —
          same component the edit page uses, so the two cannot drift. */ null}
    ${amenityPicker(opts.amenityGroups, new Set())}

    <p class="small muted">
      Only tick what the property actually has. Descriptions are checked against
      this list, and a listing that claims something it does not have is a
      problem for you as well as for us.
    </p>

    <button class="btn btn-primary" type="submit" style="width:100%">Save as draft</button>
  </form>
</div>`,
  );
}

function numField(name: string, label: string, type: string, placeholder: string): Html {
  return html`
<div class="field">
  <label for="${name}">${label}</label>
  <input id="${name}" type="${type}" name="${name}" placeholder="${placeholder}"
         ${type === 'number' ? html`min="0"` : null}>
</div>`;
}

// ── inbox ───────────────────────────────────────────────────────────────────

export function inboxPage(opts: Flash & { viewer: Viewer; threads: ThreadSummary[] }): string {
  const unread = opts.threads.reduce((n, t) => n + t.unreadCount, 0);
  return page(
    { title: unread > 0 ? `Messages (${unread})` : 'Messages', viewer: opts.viewer, path: '/messages' , notice: opts.notice, error: opts.error },
    html`
<div class="wrap" style="max-width:820px;padding:26px 20px 60px">
  <h1>Messages</h1>
  ${opts.threads.length === 0
    ? html`<div class="empty">
             <p>No messages yet.</p>
             <p class="small">Enquiries about your listings will appear here.</p>
           </div>`
    : html`<div style="border:1px solid var(--line);border-radius:var(--radius);overflow:hidden">
             ${opts.threads.map(threadRow)}
           </div>`}
</div>`,
  );
}

function threadRow(t: ThreadSummary): Html {
  return html`
<a href="/messages/${t.id}"
   style="display:block;padding:14px 16px;border-bottom:1px solid var(--line);color:inherit">
  <div style="display:flex;align-items:baseline;gap:10px">
    <strong style="font-size:15px">${t.listingTitle}</strong>
    ${t.unreadCount > 0
      ? html`<span class="badge badge-live">${t.unreadCount} new</span>`
      : null}
    ${t.status === 'blocked'
      ? html`<span class="badge badge-warn">${t.blockedByMe ? 'You blocked this' : 'Blocked'}</span>`
      : null}
    <span class="small muted" style="margin-left:auto">
      ${t.lastAt.toLocaleDateString('en-CA')}
    </span>
  </div>
  <div class="small muted" style="margin-top:4px">
    ${t.role === 'owner' ? 'Enquiry about your listing' : 'You enquired'}
    ${t.lastPreview ? html` · ${t.lastPreview}` : null}
  </div>
</a>`;
}

// ── one thread ──────────────────────────────────────────────────────────────

export function threadPage(opts: Flash & { viewer: Viewer; thread: ThreadDetail }): string {
  const t = opts.thread;
  const closed = t.status === 'blocked';
  return page(
    { title: t.listingTitle, viewer: opts.viewer, path: `/messages/${t.id}` , notice: opts.notice, error: opts.error },
    html`
<div class="wrap" style="max-width:720px;padding:22px 20px 60px">
  <p class="small"><a href="/messages">← All messages</a></p>
  <h1 style="font-size:21px">
    <a href="/listings/${t.listingId}" style="color:inherit">${t.listingTitle}</a>
  </h1>
  <p class="small muted" style="margin-top:-6px">
    ${t.role === 'owner' ? 'Someone enquired about your listing' : 'Your enquiry'}
  </p>

  <p class="notice" style="margin-top:16px">
    Arrange to see the property in person. Never send a deposit, e-transfer or
    banking details before you have — no genuine owner needs money to show you a flat.
  </p>

  <div class="stack" style="margin:20px 0">
    ${t.messages.length === 0
      ? html`<p class="muted">No messages yet.</p>`
      : t.messages.map((m) => bubble(m.mine, m.body, m.createdAt, m.flagged))}
  </div>

  ${/* Two SIBLING forms, never nested. A <form> inside a <form> is invalid
        HTML and browsers silently drop the inner one — so "Block" would have
        submitted the reply instead, which is the opposite of what someone
        clicking it wants. Caught by looking at the rendered page. */ null}
  ${closed
    ? html`
      <div class="notice notice-warn">
        This conversation is closed.
        ${t.blockedByMe ? html`You blocked it.` : null}
      </div>
      ${t.blockedByMe
        ? html`<form method="post" action="/messages/${t.id}/unblock">
                 ${csrfField(opts.viewer)}
                 <button class="btn" type="submit">Unblock this conversation</button>
               </form>`
        : null}`
    : html`
      <form method="post" action="/messages/${t.id}/reply" class="stack">
        ${csrfField(opts.viewer)}
        <div class="field">
          <label for="reply">Reply</label>
          <textarea id="reply" name="body" rows="4" required></textarea>
        </div>
        <button class="btn btn-primary" type="submit">Send</button>
      </form>
      <form method="post" action="/messages/${t.id}/block"
            style="margin-top:14px;border-top:1px solid var(--line);padding-top:14px">
        ${csrfField(opts.viewer)}
        <button class="btn btn-sm" type="submit">Block this conversation</button>
        <p class="small muted" style="margin:8px 0 0">
          They will not be able to write to you about this listing again.
        </p>
      </form>`}
</div>`,
  );
}

function bubble(mine: boolean, body: string, at: Date, flagged: boolean): Html {
  return html`
<div style="display:flex;${mine ? 'justify-content:flex-end' : ''}">
  <div style="max-width:76%;padding:11px 13px;border-radius:12px;
              background:${mine ? 'var(--tint)' : 'var(--surface)'};
              ${mine ? 'border:1px solid #d5e3f7' : ''}">
    ${flagged
      ? html`<p class="small" style="margin:0 0 6px;color:#8a5a10;font-weight:600">
               ⚠ This message looked risky to us. Read it carefully.
             </p>`
      : null}
    <div style="white-space:pre-wrap">${body}</div>
    <div class="small muted" style="margin-top:5px">
      ${at.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}
    </div>
  </div>
</div>`;
}
