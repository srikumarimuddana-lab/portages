/**
 * Saved searches.
 *
 * The demand-side retention mechanism: someone who does not find a home this
 * week comes back when one appears, without having to remember to look. On a
 * marketplace with no inventory yet, that is the difference between a visitor
 * and a waiting buyer.
 *
 * THE ALERT TOGGLE IS A CONSENT CONTROL, not a preference, and the page is
 * written that way. Turning it on is express consent under CASL; turning it
 * off is a withdrawal that must be honoured immediately. So the control says
 * what it does in plain words, the frequency is visible rather than buried,
 * and there is no pre-ticked box anywhere on this page — a pre-ticked consent
 * box is not consent, and CASL says so explicitly.
 */
import { html, raw, type Html } from './html.js';
import { page, csrfField, money, type Flash, type Viewer } from './layout.js';
import { icon, iconSprite } from './icons.js';

export interface SavedSearchCard {
  id: string;
  name: string;
  /** The filters, already turned into readable phrases. */
  summary: string[];
  /** Where running it goes. */
  href: string;
  frequency: string;
  alertEnabled: boolean;
  lastRunAt: Date | null;
}

const FREQUENCY_COPY: Record<string, string> = {
  instant: 'As they appear',
  daily: 'Once a day',
  weekly: 'Once a week',
};

export function savedSearchesPage(opts: Flash & {
  viewer: Viewer;
  searches: SavedSearchCard[];
  frequencies: readonly string[];
  /** False when no email channel is configured; alerts cannot be sent. */
  alertsAvailable: boolean;
}): string {
  return page(
    {
      title: 'Saved searches',
      viewer: opts.viewer,
      path: '/account/searches',
      notice: opts.notice,
      error: opts.error,
    },
    html`
${iconSprite()}
<div class="wrap" style="max-width:760px;padding:30px 20px 60px">
  <h1>Saved searches</h1>
  <p class="muted" style="margin-top:-4px">
    Keep a search you want to come back to, and we can tell you when something
    new matches it.
  </p>

  ${!opts.alertsAvailable
    ? html`<p class="notice notice-warn">
             Email is not configured on this deployment, so alerts cannot be
             sent. Saved searches still work — you can run them from here.
           </p>`
    : null}

  ${opts.searches.length === 0
    ? html`
      <div class="empty" style="padding:40px 20px">
        <p>No saved searches yet.</p>
        <p class="small">
          Run a search, then use <strong>Save this search</strong> under the
          filters.
        </p>
        <p style="margin-top:16px"><a class="btn btn-primary" href="/search">Search listings</a></p>
      </div>`
    : html`
      <div style="margin-top:20px">
        ${opts.searches.map((s) => savedRow(opts.viewer, s, opts.frequencies, opts.alertsAvailable))}
      </div>`}
</div>`,
  );
}

function savedRow(
  viewer: Viewer,
  s: SavedSearchCard,
  frequencies: readonly string[],
  alertsAvailable: boolean,
): Html {
  return html`
<div style="border:1px solid var(--line);border-radius:var(--radius);
            padding:14px 16px;margin-bottom:12px">
  <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
    <a href="${s.href}" style="font-weight:600;font-size:15.5px">${s.name}</a>
    ${s.alertEnabled
      ? html`<span class="badge badge-live">Alerts on</span>`
      : null}
    <form method="post" action="/account/searches/${s.id}/delete" style="margin-left:auto">
      ${csrfField(viewer)}
      <button class="btn btn-sm" type="submit" title="Remove"
              aria-label="Remove the saved search ${s.name}">${icon('trash', 'ico-sm')}</button>
    </form>
  </div>

  ${s.summary.length > 0
    ? html`<div style="margin:8px 0 0">
             ${s.summary.map((f) => html`<span class="chip">${f}</span>`)}
           </div>`
    : html`<p class="small muted" style="margin:6px 0 0">Every listing.</p>`}

  ${/* The consent control. Its wording is the record of what was agreed to,
        so it says what will be sent, how often, and by what means — and the
        box is never pre-ticked, because a pre-ticked consent box is not
        consent under CASL. */ null}
  <form method="post" action="/account/searches/${s.id}/alert"
        style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px;
               display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    ${csrfField(viewer)}
    <label style="display:flex;align-items:center;gap:8px;font-weight:400;margin:0">
      <input type="checkbox" name="enabled" value="true" style="width:auto"
             ${s.alertEnabled ? raw('checked') : null}
             ${alertsAvailable ? null : raw('disabled')}>
      <span class="small">Email me new matches</span>
    </label>
    <select name="frequency" style="width:auto;padding:6px 10px;font-size:13px"
            aria-label="How often to send alerts for ${s.name}">
      ${frequencies.map((f) => html`
        <option value="${f}" ${s.frequency === f ? raw('selected') : null}>
          ${FREQUENCY_COPY[f] ?? f}
        </option>`)}
    </select>
    <button class="btn btn-sm" type="submit">Save</button>
    <span class="small muted" style="margin-left:auto">
      ${s.lastRunAt
        ? html`Last checked ${s.lastRunAt.toISOString().slice(0, 10)}`
        : html`Not checked yet`}
    </span>
  </form>
</div>`;
}

/**
 * The "save this search" control, rendered under the filters.
 *
 * Anonymous visitors get a link to sign in rather than a form that will fail —
 * a saved search belongs to an account, and finding that out after typing a
 * name is the kind of small insult that loses someone.
 *
 * There is no alert checkbox here on purpose. Consent asked for in passing,
 * bundled into another action, is the weakest kind and the hardest to defend;
 * the toggle lives on the saved-searches page where it is the subject rather
 * than a detail.
 */
export function saveSearchControl(opts: {
  viewer: Viewer | null;
  /** The current search, as the query string to store. */
  query: string;
  /** A name suggested from the filters, which the person can change. */
  suggestedName: string;
  /** True when this exact search is already saved. */
  alreadySaved: boolean;
}): Html {
  if (!opts.viewer) {
    return html`
<p class="small muted" style="margin-top:12px">
  <a href="/signin?next=${encodeURIComponent(`/search?${opts.query}`)}">Sign in</a>
  to save this search and be told when something new matches it.
</p>`;
  }

  if (opts.alreadySaved) {
    return html`
<p class="small muted" style="margin-top:12px;display:flex;align-items:center;gap:6px">
  ${icon('check', 'ico-sm')} Saved.
  <a href="/account/searches">Manage your saved searches</a>
</p>`;
  }

  return html`
<form method="post" action="/account/searches" class="save-search">
  ${csrfField(opts.viewer)}
  <input type="hidden" name="query" value="${opts.query}">
  <label for="save-name" class="small">Save this search</label>
  <div style="display:flex;gap:8px">
    <input id="save-name" type="text" name="name" required maxlength="120"
           value="${opts.suggestedName}" aria-label="Name for this saved search">
    <button class="btn" type="submit">Save</button>
  </div>
</form>`;
}

/**
 * A name for a search, from the search itself.
 *
 * Not decoration: a list of saved searches all called "Search" is a list
 * nobody can use, and asking someone to invent a name is the step at which
 * they abandon the form.
 */
export function suggestName(v: {
  q?: string | undefined;
  mode?: string | undefined;
  minBeds?: number | undefined;
  maxPrice?: number | undefined;
  city?: string | undefined;
}): string {
  const parts: string[] = [];
  if (v.minBeds) parts.push(`${v.minBeds}+ bed`);
  if (v.mode === 'rent') parts.push('rentals');
  else if (v.mode === 'sale') parts.push('for sale');
  if (v.maxPrice) parts.push(`under ${money(v.maxPrice * 100)}`);
  if (v.q) parts.push(`“${v.q}”`);

  const name = parts.join(' ').trim();
  if (!name) return `Regina listings`;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
