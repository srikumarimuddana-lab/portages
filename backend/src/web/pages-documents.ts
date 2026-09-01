/**
 * The document locker.
 *
 * This is the whole of what the product offers instead of lease generation and
 * rent collection — a decision made early and deliberately. Portage does not
 * write a tenancy agreement or move anyone's money; it holds the papers that
 * already exist, for the people they belong to, and deletes them when their
 * purpose has expired. Everything on this page follows from that.
 *
 * The consequence for the design is that RETENTION IS NOT A DETAIL. Every
 * document here has an expiry the person did not choose and cannot extend by
 * doing nothing, because PIPEDA principle 4.5.3 requires personal information
 * to be destroyed once the purpose it was collected for is done. A locker that
 * silently keeps a lease for a decade is not a feature, it is a liability, so
 * the date is shown on every row rather than buried in a policy nobody opens.
 *
 * Uploads use the same three-step exchange as listing photos and for the same
 * reason: the bytes go straight to object storage and never pass through this
 * server. A tenancy agreement is more sensitive than a photo of a kitchen, and
 * the fewer places it exists the better.
 */
import { html, raw, type Html } from './html.js';
import { page, csrfField, type Flash, type Viewer } from './layout.js';
import { icon, iconSprite } from './icons.js';

const KIND_COPY: Record<string, string> = {
  agreement: 'Tenancy agreement',
  invoice: 'Invoice',
  receipt: 'Receipt',
  inspection: 'Inspection report',
  insurance: 'Insurance',
  condo_doc: 'Condo document',
  other: 'Other',
};

export interface DocumentCard {
  id: string;
  title: string;
  kind: string;
  mime: string;
  bytes: number;
  createdAt: Date;
  retentionUntil: Date;
  isOwner: boolean;
}

export function documentsPage(opts: Flash & {
  viewer: Viewer;
  documents: DocumentCard[];
  kinds: readonly string[];
  maxBytes: number;
  /** False when object storage is unconfigured — nothing can be stored. */
  uploadsConfigured: boolean;
  now?: Date;
}): string {
  const now = opts.now ?? new Date();

  return page(
    {
      title: 'Documents',
      viewer: opts.viewer,
      path: '/account/documents',
      notice: opts.notice,
      error: opts.error,
    },
    html`
${iconSprite()}
<div class="wrap" style="max-width:760px;padding:30px 20px 60px">
  <h1>Documents</h1>
  <p class="muted" style="margin-top:-4px">
    A private place for the papers a tenancy produces — the agreement, receipts,
    the inspection report. Portage does not write these or sign them; it keeps
    the ones you already have.
  </p>

  ${/* Said on the page rather than in a policy, because it is a promise the
        product makes and a thing people are entitled to know before they
        upload a document with their signature on it. */ null}
  <p class="notice">
    Only you can open these. We delete each one when its retention period ends
    — every row below shows its own date.
  </p>

  ${!opts.uploadsConfigured
    ? html`<p class="notice notice-warn">
             Document storage is not configured on this deployment, so nothing
             can be uploaded here yet.
           </p>`
    : uploader(opts.viewer, opts.kinds, opts.maxBytes)}

  ${/* No "shared with you" section. Sharing a document is built in the
        service and has no way to be started from the product yet, so the
        section would be empty for everyone forever — which is the same dead
        end as a link to a page that does not exist. It belongs here when
        there is a way to grant a share. */ null}
  ${opts.documents.length === 0
    ? html`<div class="empty" style="padding:32px 20px">
             <p>Nothing here yet.</p>
             <p class="small">Anything you add is private to you.</p>
           </div>`
    : html`<div style="border:1px solid var(--line);border-radius:var(--radius);
                       overflow:hidden;margin-top:20px">
             ${opts.documents.map((d) => documentRow(opts.viewer, d, now))}
           </div>`}
</div>`,
  );
}

/**
 * How long is left, in the units a person thinks in.
 *
 * "Deleted on 2027-03-14" answers a question nobody asked. "Kept for another
 * 11 months" is the same fact in the form that decides whether you need to
 * download a copy today.
 */
function retention(until: Date, now: Date): { text: string; soon: boolean } {
  const days = Math.ceil((until.getTime() - now.getTime()) / 86_400_000);
  if (days <= 0) return { text: 'Due for deletion', soon: true };
  if (days <= 30) return { text: `Deleted in ${days} day${days === 1 ? '' : 's'}`, soon: true };
  const months = Math.round(days / 30);
  if (months < 24) return { text: `Kept for another ${months} months`, soon: false };
  return { text: `Kept until ${until.toISOString().slice(0, 10)}`, soon: false };
}

function documentRow(viewer: Viewer, d: DocumentCard, now: Date): Html {
  const left = retention(d.retentionUntil, now);
  return html`
<div class="doc-row">
  <span style="color:var(--muted)">${icon(d.mime === 'application/pdf' ? 'box' : 'image')}</span>
  <div class="doc-main">
    <strong>${d.title}</strong>
    <span class="small muted">
      ${KIND_COPY[d.kind] ?? d.kind} · ${fileSize(d.bytes)} ·
      added ${d.createdAt.toISOString().slice(0, 10)}
    </span>
  </div>
  <div class="doc-actions">
    <span class="badge ${left.soon ? 'badge-warn' : 'badge-draft'}"
          title="${d.retentionUntil.toISOString().slice(0, 10)}">${left.text}</span>

    ${/* A link, not a form: a download is a read. It lands on a route that
          checks access and then redirects to a short-lived presigned URL, so
          the bytes never pass through us and the URL cannot be shared. */ null}
    <a class="btn btn-sm" href="/account/documents/${d.id}/download">Download</a>

    ${d.isOwner
      ? html`
        <form method="post" action="/account/documents/${d.id}/delete"
              onsubmit="return confirm('Delete this document? This cannot be undone.')">
          ${csrfField(viewer)}
          <button class="btn btn-sm" type="submit" aria-label="Delete ${d.title}"
                  title="Delete">${icon('trash', 'ico-sm')}</button>
        </form>`
      : null}
  </div>
</div>`;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uploader(viewer: Viewer, kinds: readonly string[], maxBytes: number): Html {
  return html`
<div class="drop" id="doc-drop" style="margin-top:22px;text-align:left">
  <form id="doc-form" class="stack" style="margin:0">
    ${csrfField(viewer)}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px">
      <div class="field" style="margin:0">
        <label for="doc-title">Title</label>
        <input id="doc-title" type="text" name="title" required maxlength="200"
               placeholder="Tenancy agreement, 2100 Victoria Ave">
      </div>
      <div class="field" style="margin:0">
        <label for="doc-kind">Kind</label>
        <select id="doc-kind" name="kind">
          ${kinds.map((k) => html`<option value="${k}">${KIND_COPY[k] ?? k}</option>`)}
        </select>
      </div>
    </div>
    <div class="field" style="margin:0">
      <label for="doc-file">File</label>
      <input id="doc-file" type="file" style="width:auto"
             accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
      <p class="small muted" style="margin:6px 0 0" id="doc-status">
        PDF, image, Word or text. Up to ${String(Math.round(maxBytes / (1024 * 1024)))} MB.
        It goes straight to storage — it does not pass through our servers.
      </p>
    </div>
    <button class="btn btn-primary" type="submit" id="doc-send">Add the document</button>
  </form>
</div>

${/* No usable fallback exists here, and saying so is better than rendering a
      button that cannot work. The three-step direct-to-storage exchange is
      what keeps the file off our servers, and no single form can perform it. */ null}
<noscript>
  <p class="notice notice-warn">
    Adding a document needs JavaScript, because the file is sent straight to
    storage rather than through our server.
  </p>
</noscript>

<script>${raw(DOC_UPLOAD_SCRIPT)}</script>`;
}

/**
 * The same three steps as a listing photo, against the documents API.
 *
 * No canvas resize here, deliberately. A photo can be re-encoded because only
 * its appearance matters; a document is evidence, and re-encoding a signed PDF
 * to save bandwidth would change the bytes someone may later need to prove.
 */
const DOC_UPLOAD_SCRIPT = `
(function () {
  var form = document.getElementById('doc-form');
  var file = document.getElementById('doc-file');
  var status = document.getElementById('doc-status');
  var send = document.getElementById('doc-send');
  if (!form || !file) return;

  function say(text) { if (status) status.textContent = text; }

  function csrf() {
    var m = document.cookie.match(/(?:^|; )__Host-portage_csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function reason(res, fallback) {
    try {
      var body = await res.json();
      return (body && body.error && body.error.message) || fallback;
    } catch (e) { return fallback; }
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var chosen = file.files && file.files[0];
    if (!chosen) { say('Choose a file first.'); return; }

    var title = form.querySelector('[name=title]').value.trim();
    if (!title) { say('Give it a title, so you can find it later.'); return; }

    send.disabled = true;
    try {
      say('Preparing…');
      var ticketRes = await fetch('/api/documents', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-portage-csrf': csrf() },
        body: JSON.stringify({
          title: title,
          kind: form.querySelector('[name=kind]').value,
          mime: chosen.type,
          bytes: chosen.size,
          filename: chosen.name
        })
      });
      if (!ticketRes.ok) throw new Error(await reason(ticketRes, 'That file was not accepted.'));
      var ticket = await ticketRes.json();
      if (!ticket.uploadUrl) throw new Error('Document storage is not configured.');

      say('Uploading…');
      var put = await fetch(ticket.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': chosen.type },
        body: chosen
      });
      if (!put.ok) throw new Error('Storage refused the upload. Try again.');

      var done = await fetch('/api/uploads/complete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-portage-csrf': csrf() },
        body: JSON.stringify({ completionToken: ticket.uploadToken })
      });
      if (!done.ok) throw new Error(await reason(done, 'The upload could not be confirmed.'));

      say('Added. Refreshing…');
      window.location.reload();
    } catch (err) {
      say((err && err.message) || 'That did not work. Try again.');
      send.disabled = false;
    }
  });
})();`;
