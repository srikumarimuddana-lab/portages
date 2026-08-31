/**
 * Editing a listing, and its photos.
 *
 * This page closes the dead end in the owner flow: a draft could be created
 * and could not be given photos, while `submit` requires at least one — so
 * every new listing stopped one step short of being submittable.
 *
 * PHOTOS ARE THE ONE PLACE THIS SITE NEEDS JAVASCRIPT, and it is worth being
 * plain about why rather than treating it as an oversight. Uploads go
 * straight from the browser to object storage on a presigned PUT; the bytes
 * never pass through our server. That is a deliberate choice made back when
 * the storage module was built — it keeps a 4MB photo off a serverless
 * function's memory and out of its execution time — and it is a three-step
 * dance (ask for a ticket, PUT, confirm) that no single <form> can perform.
 *
 * The three steps post to the EXISTING JSON API, not to new page endpoints.
 * `POST /api/listings/:id/photos` and `POST /api/uploads/complete` already do
 * this work behind the full guard — rate limits, the `uploads.new` kill
 * switch, origin and CSRF header checks — and a second set of handlers under
 * /dashboard would be a second, weaker copy of all of it.
 *
 * Everything else on this page is a plain form and works with scripting off:
 * the details, removing a photo, attesting an AI description, submitting for
 * review. Only adding a photo needs the script, and the page says so where
 * the uploader would be rather than silently doing nothing.
 */
import { html, raw, type Html } from './html.js';
import { page, money, csrfField, type Flash, type Viewer } from './layout.js';
import { MAX_PHOTOS } from '../modules/listings/policy.js';
import type { ListingView, PhotoView } from '../modules/listings/service.js';

/** Database keys read like database keys; these are what a renter would say. */
const ROOM_TYPE_COPY: Record<string, string> = {
  entire: 'The whole place',
  private: 'A private room',
  shared: 'A shared room',
};

const ACTION_COPY: Record<string, string> = {
  submit: 'Submit for review',
  publish: 'Publish',
  pause: 'Pause',
  resume: 'Resume',
  close: 'Mark as closed',
  archive: 'Archive',
};

export function editListingPage(opts: Flash & {
  viewer: Viewer;
  listing: ListingView;
  amenities: readonly string[];
  roomTypes: readonly string[];
  aiEnabled: boolean;
  /** False when object storage is unconfigured — the uploader cannot work. */
  uploadsConfigured: boolean;
  /** Problems the fact check found in an AI draft, if one was just refused. */
  draftProblems?: Array<{ phrase: string; explanation: string }>;
}): string {
  const l = opts.listing;
  const has = new Set(l.amenities);
  const needsPhoto = l.photos.length === 0;
  const needsAttestation = l.descriptionSource !== 'human' && !l.descriptionAttested;

  return page(
    {
      title: `Edit: ${l.title}`,
      viewer: opts.viewer,
      path: `/dashboard/listings/${l.id}/edit`,
      notice: opts.notice,
      error: opts.error,
    },
    html`
<div class="wrap" style="max-width:760px;padding:26px 20px 60px">
  <p class="small"><a href="/dashboard/listings">← My listings</a></p>
  <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
    <h1 style="margin:0">${l.title}</h1>
    <span class="muted">${money(l.priceCents)}${l.mode === 'rent' ? '/mo' : ''}</span>
    <a class="btn btn-sm" href="/listings/${l.id}" style="margin-left:auto">Preview</a>
  </div>
  <p class="muted small" style="margin-top:4px">
    ${l.address.addressLine}${l.address.unit ? html` #${l.address.unit}` : null},
    ${l.address.city}
  </p>

  ${/* What is still needed before this can go live, said once and plainly
        rather than discovered by pressing a button that refuses. */ null}
  ${needsPhoto || needsAttestation
    ? html`<div class="notice notice-warn">
             <strong>Before this can be submitted:</strong>
             <ul style="margin:6px 0 0;padding-left:18px">
               ${needsPhoto ? html`<li>Add at least one photo.</li>` : null}
               ${needsAttestation
                 ? html`<li>Read the description and confirm it is accurate.</li>`
                 : null}
             </ul>
           </div>`
    : null}

  ${photoSection(opts.viewer, l, opts.uploadsConfigured)}

  ${needsAttestation ? attestation(opts.viewer, l) : null}

  ${opts.draftProblems && opts.draftProblems.length > 0
    ? html`
      <div class="notice notice-warn" style="margin-top:22px">
        <strong>The draft was not used.</strong> It said things your listing does
        not support, and publishing those would be a false advertising claim:
        <ul style="margin:6px 0 0;padding-left:18px">
          ${opts.draftProblems.map((p) => html`
            <li>“${p.phrase}” — ${p.explanation}</li>`)}
        </ul>
      </div>`
    : null}

  <h2 style="margin-top:30px">Details</h2>
  <form method="post" action="/dashboard/listings/${l.id}/edit" class="stack">
    ${csrfField(opts.viewer)}

    <div class="field">
      <label for="title">Title</label>
      <input id="title" type="text" name="title" required maxlength="120" value="${l.title}">
    </div>

    ${/* Room type is a rental idea — you do not sell a room in a house — and
          `roomTypeAllowed` refuses it on a sale. So the field is absent there
          rather than present and rejected on save. */ null}
    ${/* auto-fit + minmax rather than a fixed column count: these are inline
          styles, so no media query can reach them, and a phone at 390px would
          otherwise get two columns that do not fit. */ null}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px">
      <div class="field">
        <label for="price">Price${l.mode === 'rent' ? ' per month' : ''}</label>
        <input id="price" type="number" name="priceDollars" min="1" step="0.01" required
               value="${(l.priceCents / 100).toString()}">
      </div>
      ${opts.roomTypes.length > 0
        ? html`
      <div class="field">
        <label for="roomType">Room type</label>
        <select id="roomType" name="roomType">
          <option value="">Not specified</option>
          ${opts.roomTypes.map((t) => html`
            <option value="${t}" ${l.roomType === t ? raw('selected') : null}>
              ${ROOM_TYPE_COPY[t] ?? t}
            </option>`)}
        </select>
      </div>`
        : null}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:14px">
      ${numberField('beds', 'Bedrooms', l.beds)}
      ${numberField('baths', 'Bathrooms', l.baths)}
      ${numberField('sqft', 'Square feet', l.sqft)}
    </div>

    <div class="field">
      <label for="description">Description</label>
      <textarea id="description" name="description" rows="9">${l.description ?? ''}</textarea>
      <p class="small muted" style="margin:6px 0 0">
        Only describe what the property actually has. Descriptions are checked
        against the amenities below.
      </p>
    </div>

    <fieldset style="border:1px solid var(--line);border-radius:8px;padding:14px">
      <legend class="small" style="font-weight:600;padding:0 6px">Amenities</legend>
      <div style="display:flex;flex-wrap:wrap;gap:2px">
        ${opts.amenities.map((a) => html`
          <label style="display:inline-flex;align-items:center;gap:6px;font-weight:400;
                        margin:0 12px 6px 0;font-size:13.5px">
            <input type="checkbox" name="amenities" value="${a}" style="width:auto"
                   ${has.has(a) ? raw('checked') : null}>
            ${a.replace(/_/g, ' ')}
          </label>`)}
      </div>
    </fieldset>

    ${/* Editing the copy clears any attestation, which is enforced by
          ListingService.update — an owner cannot attest to a clean draft and
          then rewrite it. Saying so here means the consequence is not a
          surprise. */ null}
    ${l.descriptionSource !== 'human' && l.descriptionAttested
      ? html`<p class="small muted">
               Changing the title or description will ask you to confirm it again.
             </p>`
      : null}

    <button class="btn btn-primary" type="submit">Save changes</button>
  </form>

  ${opts.aiEnabled && !l.description
    ? html`
      <form method="post" action="/dashboard/listings/${l.id}/draft"
            style="margin-top:14px;border-top:1px solid var(--line);padding-top:16px">
        ${csrfField(opts.viewer)}
        <button class="btn" type="submit">Write a first draft for me</button>
        <p class="small muted" style="margin:8px 0 0">
          Written only from the facts above. You read it and confirm it before
          anyone else sees it.
        </p>
      </form>`
    : null}

  ${(l.actions ?? []).length > 0
    ? html`
      <div style="margin-top:30px;border-top:1px solid var(--line);padding-top:18px;
                  display:flex;gap:8px;flex-wrap:wrap">
        ${(l.actions ?? []).map((a) => html`
          <form method="post" action="/dashboard/listings/${l.id}/transition">
            ${csrfField(opts.viewer)}
            <input type="hidden" name="action" value="${a}">
            <button class="btn${a === 'submit' ? ' btn-primary' : ''}" type="submit">
              ${ACTION_COPY[a] ?? a}
            </button>
          </form>`)}
      </div>`
    : null}
</div>`,
  );
}

function numberField(name: string, label: string, value: number | null): Html {
  return html`
<div class="field">
  <label for="${name}">${label}</label>
  <input id="${name}" type="number" name="${name}" min="0"
         ${name === 'baths' ? raw('step="0.5"') : null}
         value="${value === null ? '' : String(value)}">
</div>`;
}

// ── photos ──────────────────────────────────────────────────────────────────

function photoSection(viewer: Viewer, l: ListingView, uploadsConfigured: boolean): Html {
  return html`
<h2 style="margin-top:28px">Photos</h2>
<p class="small muted" style="margin-top:-6px">
  The first one is what people see in search results. Up to ${String(MAX_PHOTOS)}.
</p>

${l.photos.length > 0
  ? html`<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));
                                  gap:12px;margin:14px 0">
           ${l.photos.map((p, i) => photoTile(viewer, l.id, p, i === 0))}
         </div>`
  : null}

${!uploadsConfigured
  ? html`<p class="notice notice-warn">
           Photo storage is not configured on this deployment, so photos cannot
           be added here yet.
         </p>`
  : l.photos.length >= MAX_PHOTOS
    ? html`<p class="small muted">
             This listing has the maximum of ${String(MAX_PHOTOS)} photos. Remove
             one to add another.
           </p>`
    : html`
<div id="uploader" hidden data-listing="${l.id}"
     style="border:1px dashed var(--line-2);border-radius:10px;padding:18px;text-align:center">
  <input type="file" id="photo-input" accept="image/jpeg,image/png,image/webp" multiple
         style="width:auto">
  <p class="small muted" style="margin:10px 0 0" id="upload-status">
    JPEG, PNG or WebP. Large photos are resized before they leave your device.
  </p>
</div>

${/* The no-script fallback is a message, not a broken control. Uploads go
      straight from the browser to object storage on a presigned PUT — the
      bytes never touch our server — and that is a three-step exchange no
      single form can perform. */ null}
<noscript>
  <p class="notice notice-warn">
    Adding photos needs JavaScript, because your photo is sent straight to
    storage rather than through our server. Everything else on this page works
    without it.
  </p>
</noscript>

<script>${raw(UPLOAD_SCRIPT)}</script>`}`;
}

function photoTile(viewer: Viewer, listingId: string, p: PhotoView, isCover: boolean): Html {
  return html`
<div style="position:relative;border:1px solid var(--line);border-radius:8px;overflow:hidden">
  <img src="/media/${p.storageKey}" alt="" loading="lazy"
       style="width:100%;aspect-ratio:4/3;object-fit:cover">
  ${isCover
    ? html`<span class="badge badge-live"
                 style="position:absolute;top:6px;left:6px">Cover</span>`
    : null}
  <form method="post" action="/dashboard/listings/${listingId}/photos/${p.id}/remove"
        style="position:absolute;top:6px;right:6px">
    ${csrfField(viewer)}
    <button class="btn btn-sm" type="submit" aria-label="Remove photo"
            style="padding:3px 8px">Remove</button>
  </form>
</div>`;
}

// ── attestation ─────────────────────────────────────────────────────────────

/**
 * The owner's confirmation of an AI-written description.
 *
 * `listings_publish_guard` has refused to publish an unattested AI
 * description since migration 003. This is the only thing in the product that
 * can satisfy it, and the wording matters: the owner is being asked to take
 * responsibility for a statement about their own property, which is exactly
 * what Competition Act s.74.01 makes them and us answerable for.
 */
function attestation(viewer: Viewer, l: ListingView): Html {
  return html`
<div style="margin-top:24px;border:1px solid #f0d9a8;background:#fdf8ee;
            border-radius:10px;padding:16px">
  <h3 style="margin-top:0">Confirm the description</h3>
  <p class="small" style="margin-bottom:12px">
    This description was drafted with AI. Read it and confirm every part of it
    is true of your property. It cannot be published until you do, and if you
    change it afterwards we will ask again.
  </p>
  <div style="white-space:pre-wrap;background:#fff;border:1px solid var(--line);
              border-radius:8px;padding:12px;margin-bottom:12px">${l.description ?? ''}</div>
  <form method="post" action="/dashboard/listings/${l.id}/attest">
    ${csrfField(viewer)}
    <button class="btn btn-primary" type="submit">
      This is accurate — I confirm it
    </button>
  </form>
</div>`;
}

/**
 * The uploader.
 *
 * Three steps, which is what makes a plain form impossible: ask the API for a
 * presigned ticket, PUT the bytes to storage directly, then tell the API it
 * landed. Our server never sees the file.
 *
 * WHAT THE THIRD STEP IS FOR. Everything the browser says in step one is a
 * claim — the size, the type, that it is an image at all. `POST
 * /api/uploads/complete` is where the server reads the object back and decides
 * whether to believe it, and where EXIF (including the GPS coordinates of the
 * inside of someone's home) comes off. A photo whose PUT succeeded but whose
 * completion never ran stays `pending` and never appears on the listing, which
 * is the safe direction to fail in.
 *
 * The resize before upload is not a nicety. A modern phone photo is 4–8MB and
 * a Regina listing has twenty of them; sending them untouched costs the owner
 * their mobile data, costs us storage, and makes the listing page slow for
 * everyone afterwards. 2000px on the long edge is larger than any layout here
 * displays. Re-encoding through a canvas also drops the metadata client-side,
 * so the common case never needs the server-side rewrite at all.
 *
 * The listing id comes from a data attribute rather than being interpolated
 * into this string: no interpolation anywhere in here is what makes the
 * `raw()` above safe, and it should stay that way.
 */
const UPLOAD_SCRIPT = `
(function () {
  var box = document.getElementById('uploader');
  var input = document.getElementById('photo-input');
  var status = document.getElementById('upload-status');
  if (!box || !input) return;
  var listingId = box.getAttribute('data-listing');
  if (!listingId) return;
  box.hidden = false;

  function csrf() {
    var m = document.cookie.match(/(?:^|; )__Host-portage_csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function say(text) { if (status) status.textContent = text; }

  // The API answers { error: { code, message } }. Anything else — a proxy
  // error page, a truncated body — falls back to the caller's wording rather
  // than showing the owner "undefined".
  async function reason(res, fallback) {
    try {
      var body = await res.json();
      return (body && body.error && body.error.message) || fallback;
    } catch (e) { return fallback; }
  }

  // Downscale in a canvas. Falls back to the original file if anything about
  // the decode fails — a photo that uploads large beats one that does not.
  function shrink(file) {
    return new Promise(function (resolve) {
      if (!window.createImageBitmap) return resolve(file);
      createImageBitmap(file).then(function (bmp) {
        var max = 2000;
        var scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
        if (scale === 1 && file.size < 1500000) return resolve(file);
        var c = document.createElement('canvas');
        c.width = Math.round(bmp.width * scale);
        c.height = Math.round(bmp.height * scale);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        c.toBlob(function (blob) { resolve(blob || file); }, 'image/jpeg', 0.85);
      }).catch(function () { resolve(file); });
    });
  }

  async function upload(file) {
    var blob = await shrink(file);
    var mime = blob.type || file.type;

    var ticketRes = await fetch('/api/listings/' + encodeURIComponent(listingId) + '/photos', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-portage-csrf': csrf() },
      body: JSON.stringify({ mime: mime, bytes: blob.size })
    });
    if (!ticketRes.ok) throw new Error(await reason(ticketRes, 'Could not start the upload.'));
    var ticket = await ticketRes.json();
    if (!ticket.uploadUrl) throw new Error('Photo storage is not configured.');

    var put = await fetch(ticket.uploadUrl, {
      method: 'PUT', headers: { 'content-type': mime }, body: blob
    });
    if (!put.ok) throw new Error('Storage refused the upload. Try again.');

    var done = await fetch('/api/uploads/complete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-portage-csrf': csrf() },
      body: JSON.stringify({ completionToken: ticket.uploadToken })
    });
    if (!done.ok) throw new Error(await reason(done, 'The upload could not be confirmed.'));
    return done.json();
  }

  input.addEventListener('change', async function () {
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return;
    input.disabled = true;
    var strippedGps = false;
    try {
      for (var i = 0; i < files.length; i++) {
        say('Uploading ' + (i + 1) + ' of ' + files.length + '…');
        var out = await upload(files[i]);
        if (out && out.locationDataRemoved) strippedGps = true;
      }
      // Said out loud, because it is a change to the owner's file that they
      // did not ask for and would want to know about.
      say(strippedGps ? 'Done — location data removed. Reloading…' : 'Done. Reloading…');
      window.location.reload();
    } catch (err) {
      say((err && err.message) || 'That did not work. Try again.');
      input.disabled = false;
      input.value = '';
    }
  });
})();`;
