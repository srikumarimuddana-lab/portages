/**
 * The staff console.
 *
 * Sized for two to five decisions a day, which is the number analysis/10
 * arrived at and which drives every layout choice here: no bulk select, no
 * assignment, no filters beyond the state tabs. At this volume the failure is
 * never a queue that is too deep to work through — it is a queue nobody
 * opened for a week, so the oldest-waiting time is the headline number and
 * everything else is secondary.
 *
 * A moderator reads every item. That means the queue rows carry the SIGNAL
 * NAMES behind each risk score rather than the number alone: a rule that
 * fires wrongly is only findable if it is on the screen.
 *
 * These pages are staff-only, and the guard answers 404 rather than 403 to
 * everyone else — so a stranger who guesses the URL learns nothing. Nothing
 * here decides anything: every button posts to an admin API route where the
 * role gate, the state machine and the audit writer all apply.
 */
import { html, raw, type Html } from './html.js';
import { page, money, csrfField, type Flash, type Viewer } from './layout.js';
import type { QueueItem, QueueStats } from '../modules/admin/moderation.js';
import type { FlagState, CacheState } from '../modules/flags/service.js';

/** "3 days" beats "271,844 seconds" when the number is a reproach. */
function waited(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} hr`;
  const days = Math.round(seconds / 86_400);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * How alarmed to be about the oldest item.
 *
 * Colour rather than a number, because the point of the headline is to be
 * readable at a glance from across a room. A day is fine, three days is not.
 */
function ageTone(seconds: number | null): { cls: string; text: string } {
  if (seconds === null) return { cls: 'badge-live', text: 'Queue empty' };
  if (seconds < 86_400) return { cls: 'badge-live', text: `Oldest ${waited(seconds)}` };
  if (seconds < 3 * 86_400) return { cls: 'badge-review', text: `Oldest ${waited(seconds)}` };
  return { cls: 'badge-warn', text: `Oldest ${waited(seconds)}` };
}

// ── the queue ───────────────────────────────────────────────────────────────

/**
 * The admin sub-navigation.
 *
 * Here because two of the three admin pages were reachable only by typing
 * their URL. A console whose kill switches you have to remember the path to is
 * a console you will not reach during the incident that needs them.
 */
function adminNav(here: string): Html {
  const tabs: Array<[string, string]> = [
    ['/admin/queue', 'Queue'],
    ['/admin/flags', 'Kill switches'],
    ['/admin/audit', 'Audit trail'],
  ];
  return html`
<div class="tabs" style="margin:0 0 18px">
  ${tabs.map(([href, label]) => html`
    <a href="${href}" aria-selected="${here === href ? 'true' : 'false'}"
       style="padding:9px 13px;font:600 14px var(--font);border-bottom:2px solid ${
         here === href ? 'var(--accent)' : 'transparent'};margin-bottom:-1px;
         color:${here === href ? 'var(--accent)' : 'var(--muted)'}">${label}</a>`)}
</div>`;
}

export function queuePage(opts: Flash & {
  viewer: Viewer;
  items: QueueItem[];
  stats: QueueStats;
  state: string;
}): string {
  const tone = ageTone(opts.stats.oldestWaitingSec);
  return page(
    { title: 'Moderation queue', viewer: opts.viewer, path: '/admin/queue' , notice: opts.notice, error: opts.error },
    html`
<div class="wrap" style="padding:26px 20px 60px">
  <h1>Moderation</h1>
  ${adminNav('/admin/queue')}

  <div class="facts-row" style="border-bottom:0;gap:34px">
    <div class="fact"><b>${opts.stats.open}</b><span>waiting</span></div>
    <div class="fact"><b>${opts.stats.openListings}</b><span>listings</span></div>
    <div class="fact"><b>${opts.stats.openMessages}</b><span>messages</span></div>
    <div class="fact">
      <b><span class="badge ${tone.cls}">${tone.text}</span></b>
      <span>the number that matters</span>
    </div>
    <div class="fact" style="margin-left:auto;text-align:right">
      <b>${opts.stats.blockedLast7d} / ${opts.stats.releasedLast7d}</b>
      <span>blocked / released, 7 days</span>
    </div>
  </div>

  ${/* Blocked and released sit together on purpose. Rising blocks WITH rising
        releases means the heuristic is over-firing; rising blocks with
        releases near zero means the site is under attack. The responses are
        opposite, and neither number alone tells them apart. */ null}

  <div class="tabs" style="margin-top:8px">
    ${['open', 'approved', 'rejected'].map((s) => html`
      <a href="/admin/queue?state=${s}"
         style="padding:9px 13px;font-weight:600;font-size:14px;
                border-bottom:2px solid ${s === opts.state ? 'var(--accent)' : 'transparent'};
                color:${s === opts.state ? 'var(--accent)' : 'var(--muted)'}">
        ${s === 'open' ? 'Waiting' : s === 'approved' ? 'Approved' : 'Rejected'}
      </a>`)}
  </div>

  ${opts.items.length === 0
    ? html`<div class="empty">
             <p>${opts.state === 'open' ? 'Nothing waiting. ' : 'Nothing here. '}</p>
             <p class="small">${opts.state === 'open'
               ? 'Every listing and message has been looked at.'
               : 'Decisions you make will appear here.'}</p>
           </div>`
    : html`<div class="stack" style="margin-top:14px">${opts.items.map((i) => queueRow(i, opts.viewer))}</div>`}
</div>`,
  );
}

function queueRow(item: QueueItem, viewer: Viewer): Html {
  return html`
<div class="card" style="padding:14px 16px">
  <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
    <span class="badge ${item.riskScore >= 100 ? 'badge-warn' : 'badge-review'}">
      risk ${Math.round(item.riskScore)}
    </span>
    <strong>${item.title}</strong>
    <span class="small muted">${item.subtitle}</span>
    <span class="small muted" style="margin-left:auto">waiting ${waited(item.waitingSec)}</span>
  </div>

  ${/* The signal NAMES, not just the score. A rule that fires wrongly is only
        findable if a human can see which rule fired. */
    item.signals.length > 0
    ? html`<div style="margin-top:9px">
             ${item.signals.map((s) => html`
               <span class="chip" title="weight ${s.weight}">${s.signal.replace(/_/g, ' ')}</span>`)}
           </div>`
    : html`<p class="small muted" style="margin:9px 0 0">
             Queued on: ${item.reason.replace(/_/g, ' ')}
           </p>`}

  <div style="display:flex;gap:8px;margin-top:12px">
    <a class="btn btn-sm btn-primary"
       href="${item.subjectType === 'message'
         ? `/admin/messages/${item.subjectId}`
         : `/admin/listings/${item.subjectId}`}">
      Review
    </a>
    ${item.state === 'open'
      ? html`<form method="post" action="/admin/queue/${item.id}/dismiss">
               ${csrfField(viewer)}
               <button class="btn btn-sm" type="submit">Looked, nothing to do</button>
             </form>`
      : null}
  </div>
</div>`;
}

// ── listing review ──────────────────────────────────────────────────────────

export interface ReviewListing {
  id: string;
  title: string;
  description: string | null;
  descriptionSource: string;
  priceCents: number;
  mode: string;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  amenities: string[];
  address: { addressLine: string; city: string; province: string };
  status: string;
}

export function listingReviewPage(opts: Flash & {
  viewer: Viewer;
  listing: ReviewListing;
  signals: Array<{ signal: string; weight: number }>;
  reports: Array<{ kind: string; detail: string | null; createdAt: Date }>;
}): string {
  const l = opts.listing;
  return page(
    { title: `Review: ${l.title}`, viewer: opts.viewer, path: `/admin/listings/${l.id}` , notice: opts.notice, error: opts.error },
    html`
<div class="wrap detail" style="padding-top:22px">
  <div>
    <p class="small"><a href="/admin/queue">← Queue</a></p>
    <h1>${l.title}</h1>
    <p class="muted" style="margin-top:-4px">
      ${l.address.addressLine}, ${l.address.city}, ${l.address.province}
      · ${money(l.priceCents)}${l.mode === 'rent' ? '/mo' : ''}
    </p>

    ${opts.reports.length > 0
      ? html`
        <div class="notice notice-warn">
          <strong>${opts.reports.length} person${opts.reports.length === 1 ? '' : 's'}
          reported this.</strong>
          <ul style="margin:8px 0 0;padding-left:18px">
            ${opts.reports.map((r) => html`
              <li>${r.kind.replace(/_/g, ' ')}${r.detail ? html` — ${r.detail}` : null}</li>`)}
          </ul>
        </div>`
      : null}

    ${l.descriptionSource !== 'human'
      ? html`<p class="notice">The description was drafted with AI. The owner has
               confirmed it as accurate; it was also checked against the amenity
               list before they saw it.</p>`
      : null}

    <h2 style="margin-top:22px">Description</h2>
    ${l.description
      ? html`<p style="white-space:pre-wrap">${l.description}</p>`
      : html`<p class="muted">No description.</p>`}

    <h2 style="margin-top:22px">Amenities as listed</h2>
    <div>${l.amenities.length > 0
      ? l.amenities.map((a) => html`<span class="chip chip-tint">${a.replace(/_/g, ' ')}</span>`)
      : html`<span class="muted">None</span>`}</div>

    ${opts.signals.length > 0
      ? html`<h2 style="margin-top:22px">Automated signals</h2>
             <div>${opts.signals.map((s) => html`
               <span class="chip">${s.signal.replace(/_/g, ' ')} · ${s.weight}</span>`)}</div>`
      : null}
  </div>

  <aside class="aside">
    <h3 style="margin-top:0">Decide</h3>
    <p class="small muted">
      Approving publishes this to everyone. Rejecting sends the reason to the owner.
    </p>

    <form method="post" action="/admin/listings/${l.id}/decide" class="stack">
      ${csrfField(opts.viewer)}
      <input type="hidden" name="action" value="approve">
      <button class="btn btn-primary" type="submit" style="width:100%">Approve and publish</button>
    </form>

    <form method="post" action="/admin/listings/${l.id}/decide" class="stack"
          style="margin-top:16px;border-top:1px solid var(--line);padding-top:16px">
      ${csrfField(opts.viewer)}
      <input type="hidden" name="action" value="reject">
      <div class="field">
        <label for="reason">Reason (the owner sees this)</label>
        <textarea id="reason" name="reason" rows="3" required minlength="4"
          placeholder="The photos appear to be of a different property."></textarea>
      </div>
      <button class="btn" type="submit" style="width:100%">Reject</button>
      ${/* Required, and required for a reason: a rejection with no explanation
            is a listing that gets resubmitted unchanged. */ null}
    </form>
  </aside>
</div>`,
  );
}

// ── message review ──────────────────────────────────────────────────────────

export interface ReviewMessage {
  id: string;
  body: string;
  verdict: string;
  flaggedReasons: string[];
  delivered: boolean;
  isFirstContact: boolean;
  createdAt: Date;
  sender: { email: string; emailVerified: boolean; blockedCount: number };
  recipient: { email: string };
  listing: { id: string; title: string };
  context: Array<{ body: string; mine: boolean; createdAt: Date }>;
}

export function messageReviewPage(opts: Flash & { viewer: Viewer; message: ReviewMessage }): string {
  const m = opts.message;
  return page(
    { title: 'Review message', viewer: opts.viewer, path: `/admin/messages/${m.id}` , notice: opts.notice, error: opts.error },
    html`
<div class="wrap" style="max-width:820px;padding:22px 20px 60px">
  <p class="small"><a href="/admin/queue">← Queue</a></p>
  <h1>Withheld message</h1>

  <p class="notice notice-warn">
    This message was <strong>not delivered</strong>. The sender was told it was
    held; the recipient does not know it exists. Releasing it delivers it now
    and notifies them.
  </p>

  <div class="facts-row">
    <div class="fact"><b>${m.sender.blockedCount}</b><span>prior blocks by sender</span></div>
    <div class="fact"><b>${m.sender.emailVerified ? 'Yes' : 'No'}</b><span>email verified</span></div>
    <div class="fact"><b>${m.isFirstContact ? 'Yes' : 'No'}</b><span>first contact</span></div>
    <div class="fact"><b>${m.verdict}</b><span>scanner verdict</span></div>
  </div>

  <p class="small muted">
    About <a href="/listings/${m.listing.id}">${m.listing.title}</a> ·
    from ${m.sender.email} to ${m.recipient.email}
  </p>

  <h2 style="margin-top:20px">The message</h2>
  <div style="border:1px solid #f0d9a8;background:#fdf8ee;border-radius:10px;padding:14px">
    <div style="white-space:pre-wrap">${m.body}</div>
  </div>
  <div style="margin-top:10px">
    ${m.flaggedReasons.map((r) => html`<span class="chip">${r.replace(/_/g, ' ')}</span>`)}
  </div>

  ${m.context.length > 0
    ? html`
      <h2 style="margin-top:24px">The conversation so far</h2>
      <p class="small muted" style="margin-top:-6px">
        The same sentence means different things in message one and message ten.
        That is the judgement the scanner made and you are now checking.
      </p>
      <div class="stack">
        ${m.context.map((c) => html`
          <div style="padding:11px 13px;border-radius:10px;background:var(--surface)">
            <div style="white-space:pre-wrap">${c.body}</div>
            <div class="small muted" style="margin-top:5px">
              ${c.createdAt.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}
            </div>
          </div>`)}
      </div>`
    : html`<p class="muted" style="margin-top:20px">No earlier messages in this thread.</p>`}

  <div style="display:flex;gap:10px;margin-top:26px;border-top:1px solid var(--line);padding-top:20px">
    <form method="post" action="/admin/messages/${m.id}/decide">
      ${csrfField(opts.viewer)}
      <input type="hidden" name="action" value="release">
      <button class="btn btn-primary" type="submit">Release — the scanner was wrong</button>
    </form>
    <form method="post" action="/admin/messages/${m.id}/decide">
      ${csrfField(opts.viewer)}
      <input type="hidden" name="action" value="uphold">
      <button class="btn" type="submit">Uphold the block</button>
    </form>
  </div>
</div>`,
  );
}

// ── kill switches ───────────────────────────────────────────────────────────

export function flagsPage(opts: Flash & {
  viewer: Viewer;
  flags: FlagState[];
  cache: CacheState;
}): string {
  const canFlip = opts.viewer.role === 'admin';
  return page(
    { title: 'Kill switches', viewer: opts.viewer, path: '/admin/flags' , notice: opts.notice, error: opts.error },
    html`
<div class="wrap" style="max-width:900px;padding:26px 20px 60px">
  <h1>Kill switches</h1>
  ${adminNav('/admin/flags')}
  <p class="muted" style="margin-top:-4px">
    A switch takes effect everywhere within about ten seconds. No deploy.
  </p>

  ${/* The cache state is on the screen because a console showing "email: on"
        while the process has been unable to read the flag store for a minute
        is telling you something it does not know. */ null}
  ${opts.cache === 'fresh'
    ? null
    : html`<p class="notice notice-warn">
             ${opts.cache === 'stale'
               ? 'The flag store has not been readable for a moment. These values are the last known good ones.'
               : 'The flag store is unreachable. Features are running on their fail-safe defaults, not on what is shown here.'}
           </p>`}

  ${canFlip
    ? null
    : html`<p class="notice">You can see the switches. Only an admin can move one.</p>`}

  <div class="stack" style="margin-top:18px">
    ${opts.flags.map((f) => flagRow(f, canFlip, opts.viewer))}
  </div>
</div>`,
  );
}

function flagRow(f: FlagState, canFlip: boolean, viewer: Viewer): Html {
  return html`
<div class="card" style="padding:14px 16px">
  <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
    <strong>${f.label}</strong>
    <span class="small muted" style="font-family:ui-monospace,monospace">${f.key}</span>
    <span class="badge ${f.enabled ? 'badge-live' : 'badge-warn'}">
      ${f.enabled ? 'On' : 'Off'}
    </span>
    ${!f.configured
      ? html`<span class="small muted">default — never changed</span>`
      : null}
    ${canFlip
      ? html`
        <form method="post" action="/admin/flags/${f.key}" style="margin-left:auto">
          ${csrfField(viewer)}
          <input type="hidden" name="enabled" value="${f.enabled ? 'false' : 'true'}">
          <button class="btn btn-sm${f.enabled ? '' : ' btn-primary'}" type="submit">
            ${f.enabled ? 'Turn off' : 'Turn on'}
          </button>
        </form>`
      : null}
  </div>
  <p class="small muted" style="margin:8px 0 0">${f.effect}</p>
  <p class="small muted" style="margin:4px 0 0">
    If the flag store is unreadable this runs
    <strong>${f.failsafe ? 'ON' : 'OFF'}</strong>.
    ${f.note ? html` · Last note: “${f.note}”` : null}
  </p>
</div>`;
}

// ── the audit trail ─────────────────────────────────────────────────────────

/**
 * Every staff action, newest first.
 *
 * WHY THIS PAGE EXISTS AT ALL. The audit log has been written on every staff
 * decision since the moderation module was built, and nothing could read it
 * without a database client. An append-only trail nobody looks at provides
 * exactly one thing — the ability to answer a question after the fact — and
 * only if someone can actually run the query.
 *
 * It is deliberately read-only. There is no filter that mutates, no
 * "acknowledge", and no way to remove a row: an audit trail with an edit
 * button is not one.
 *
 * `before` and `after` are rendered as compact JSON rather than prose. Prose
 * would need a formatter per action, and the formatter for the action that
 * actually mattered would be the one nobody had written.
 */
export function auditPage(opts: Flash & {
  viewer: Viewer;
  entries: Array<{
    id: string; actorId: string | null; actorRole: string | null;
    action: string; subject: string; subjectId: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    at: Date;
  }>;
  actions: readonly string[];
  /** The action currently filtered on, if any. */
  action: string | null;
  /** Cursor for the next page, or null at the end. */
  nextBefore: string | null;
}): string {
  return page(
    { title: 'Audit trail', viewer: opts.viewer, path: '/admin/audit',
      notice: opts.notice, error: opts.error },
    html`
<div class="wrap" style="max-width:1000px;padding:26px 20px 60px">
  <h1>Audit trail</h1>
  ${adminNav('/admin/audit')}
  <p class="muted small" style="margin-top:-4px">
    Every staff action, newest first. Append-only — nothing here can be edited
    or removed, including by whoever performed it.
  </p>

  ${/* A GET form: filtering is a read, so it belongs in the URL where it can
        be bookmarked and shared with whoever asked the question. */ null}
  <form method="get" action="/admin/audit" class="searchbar" style="margin:16px 0">
    <select name="action" aria-label="Filter by action">
      <option value="">Every action</option>
      ${opts.actions.map((a) => html`
        <option value="${a}" ${opts.action === a ? raw('selected') : null}>${a}</option>`)}
    </select>
    <button class="btn" type="submit">Filter</button>
    ${opts.action ? html`<a class="btn" href="/admin/audit">Clear</a>` : null}
  </form>

  ${opts.entries.length === 0
    ? html`<div class="empty">
             <p>Nothing recorded${opts.action ? html` for ${opts.action}` : null} yet.</p>
           </div>`
    : html`
    <div style="border:1px solid var(--line);border-radius:var(--radius);overflow:hidden">
      ${opts.entries.map(auditRow)}
    </div>
    ${opts.nextBefore
      ? html`<p style="margin-top:16px">
               <a class="btn" href="/admin/audit?${opts.action ? html`action=${opts.action}&amp;` : null}before=${opts.nextBefore}">
                 Older entries
               </a>
             </p>`
      : null}`}
</div>`,
  );
}

function auditRow(e: {
  id: string; actorId: string | null; actorRole: string | null;
  action: string; subject: string; subjectId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: Date;
}): Html {
  const changed = e.before !== null || e.after !== null;
  return html`
<div style="padding:11px 14px;border-bottom:1px solid var(--line)">
  <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
    <code style="font-size:13px;font-weight:600;color:var(--accent)">${e.action}</code>
    <span class="small muted">${e.subject}</span>
    ${e.subjectId
      ? html`<a class="small" href="/admin/listings/${e.subjectId}"
                style="font-family:ui-monospace,monospace">${e.subjectId.slice(0, 8)}</a>`
      : null}
    <span class="small muted" style="margin-left:auto">
      ${e.actorRole ? html`<span class="chip">${e.actorRole}</span>` : null}
      ${e.at.toISOString().replace('T', ' ').slice(0, 19)}
    </span>
  </div>
  ${changed
    ? html`<pre style="margin:6px 0 0;font-size:12px;color:var(--ink-2);
                       white-space:pre-wrap;word-break:break-word">${
             JSON.stringify({ before: e.before, after: e.after })}</pre>`
    : null}
</div>`;
}
