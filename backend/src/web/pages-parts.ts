/**
 * Page fragments used by more than one page.
 *
 * Named `pages-` deliberately: the test scanners discover template files by
 * that prefix, and they are the things that catch a form with no CSRF field, a
 * nested form, or a CSS class used and never defined. A shared component file
 * outside that pattern would be exempt from all of them, which is exactly the
 * hole a hardcoded file list left in the first place.
 */
import { html, raw, type Html } from './html.js';
import { icon, hasIcon, type IconName } from './icons.js';
import type { AmenityGroup } from '../modules/listings/policy.js';

/**
 * Forty-two amenities, as tiles rather than a list of checkboxes.
 *
 * THE THING THAT WAS WRONG. A flat column of forty-two checkboxes is not a
 * form anyone fills in; it is a wall they skim. What gets skipped is whatever
 * is furthest down — and on this list that included `heated_garage` and
 * `block_heater_plug`, which are two of the things a Regina renter filters on
 * hardest between November and March. An amenity nobody ticks is a listing
 * that does not appear in the search that would have found it.
 *
 * NO SCRIPT IS INVOLVED IN THE TOGGLING. Each tile is a `<label>` wrapping a
 * real checkbox, and `input:checked + .amen-tile` does the styling. So this
 * posts exactly what the plain checkbox list posted, works with scripting off,
 * and is keyboard-operable and screen-reader-correct without any of that being
 * re-implemented. The script adds a live count and a filter box, and nothing
 * that the form depends on.
 */
export function amenityPicker(
  groups: readonly AmenityGroup[],
  has: ReadonlySet<string>,
  /**
   * The line above the tiles. Both sides of the marketplace use this picker
   * and they mean opposite things by it: an owner is declaring what the
   * property has, a searcher is saying what they want. Shared markup, not
   * shared voice.
   */
  caption = 'Tick everything the property actually has.',
): Html {
  const chosen = groups.reduce(
    (n, g) => n + g.items.filter((i) => has.has(i.key)).length, 0,
  );

  return html`
<fieldset class="field" data-amenities
          style="border:1px solid var(--line);border-radius:10px;padding:14px 14px 16px">
  <legend class="small" style="font-weight:600;padding:0 6px">Amenities</legend>

  <div class="amen-head">
    <span class="small muted">
      ${caption}
      <span class="amen-count" data-count data-n="${String(chosen)}">${String(chosen)}</span>
    </span>
    ${/* Hidden until the script reveals it: a search box that filters nothing
          is worse than no search box. */ null}
    <span class="amen-find" data-find hidden>
      ${icon('search', 'ico-sm')}
      <input type="search" data-filter placeholder="Find an amenity"
             aria-label="Filter the amenities below" autocomplete="off">
    </span>
  </div>

  ${groups.map((g) => html`
  <div class="amen-group" data-group>
    <h4>${g.label}</h4>
    <div class="amen-grid">
      ${g.items.map((it) => html`
      <label class="amen" data-amen="${it.label.toLowerCase()} ${it.key.replace(/_/g, ' ')}">
        <input type="checkbox" name="amenities" value="${it.key}"
               ${has.has(it.key) ? raw('checked') : null}>
        <span class="amen-tile">${icon(iconOf(it.icon))}${it.label}</span>
        <span class="amen-tick" aria-hidden="true">${icon('check')}</span>
      </label>`)}
    </div>
  </div>`)}

  <script>${raw(AMENITY_SCRIPT)}</script>
</fieldset>`;
}

/** Falls back to a generic mark rather than rendering an empty box. */
function iconOf(name: string): IconName {
  return hasIcon(name) ? name : 'check';
}

/**
 * Counting and filtering. Nothing here is load-bearing.
 *
 * If this script fails to run, the tiles still toggle, the form still posts
 * the same values, and the only things missing are a number and a search box
 * that was hidden to begin with.
 */
const AMENITY_SCRIPT = `
(function () {
  var root = document.querySelector('[data-amenities]');
  if (!root) return;
  var count = root.querySelector('[data-count]');
  var find = root.querySelector('[data-find]');
  var boxes = Array.prototype.slice.call(root.querySelectorAll('input[type=checkbox]'));

  function recount() {
    var n = boxes.filter(function (b) { return b.checked; }).length;
    if (!count) return;
    count.textContent = String(n);
    count.setAttribute('data-n', String(n));
  }
  root.addEventListener('change', recount);
  recount();

  if (!find) return;
  find.hidden = false;
  var input = find.querySelector('[data-filter]');
  input.addEventListener('input', function () {
    var q = input.value.trim().toLowerCase();
    root.querySelectorAll('[data-group]').forEach(function (group) {
      var shown = 0;
      group.querySelectorAll('[data-amen]').forEach(function (tile) {
        // A ticked amenity is never hidden. Filtering something out of view
        // while it is still being submitted is how an owner ends up unable to
        // find the thing they need to untick.
        var keep = !q || tile.getAttribute('data-amen').indexOf(q) !== -1
          || tile.querySelector('input').checked;
        tile.hidden = !keep;
        if (keep) shown++;
      });
      group.hidden = shown === 0;
    });
  });
})();`;

// ── search filters ──────────────────────────────────────────────────────────

/**
 * The filter panel.
 *
 * A GET FORM, and that is the whole design. Submitting navigates to
 * /search?mode=rent&minBeds=2… — so a filtered search is a URL, which means it
 * can be bookmarked, sent to the person you are moving in with, and indexed.
 * A search that lives in JavaScript state has none of those properties, and
 * for a site whose competitive position rests on arriving from a Google result
 * that is not a small thing.
 *
 * It also means the panel works with scripting off, needs no endpoint of its
 * own, and cannot get out of step with what the server actually filtered on:
 * every control is populated from the parsed spec, not from what was typed.
 *
 * PRICE IS IN DOLLARS HERE and cents everywhere behind it. People do not type
 * 150000 when they mean $1,500, and `?minPrice=1500` is a URL somebody can
 * read. The conversion happens in one adapter, next to the parse.
 */
export interface FilterValues {
  q?: string | undefined;
  mode?: string | undefined;
  propertyTypes?: readonly string[] | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  minBeds?: number | undefined;
  minBaths?: number | undefined;
  minSqft?: number | undefined;
  amenities?: readonly string[] | undefined;
  sort?: string | undefined;
}

export function searchFilters(opts: {
  values: FilterValues;
  propertyTypes: readonly string[];
  amenityGroups: readonly AmenityGroup[];
  sorts: readonly string[];
  /** How many filters are currently applied, so a collapsed panel says so. */
  activeCount: number;
  /**
   * Where "Clear filters" goes: the same search with the text query kept and
   * every filter dropped. Built by the caller, which is the only place that
   * has the real parameters — assembling it inline here meant concatenating a
   * conditional query string into an href, which is how a link ends up
   * pointing at `/searchundefined`.
   */
  clearHref: string;
}): Html {
  const v = opts.values;
  const types = new Set(v.propertyTypes ?? []);
  const has = new Set(v.amenities ?? []);

  return html`
<form method="get" action="/search" class="filters">
  ${/* The text query rides inside the same form. Without it here, refining a
        filter would silently drop the words the person searched for — the
        form only submits its own fields. */ null}
  <input type="hidden" name="q" value="${v.q ?? ''}">
  <input type="hidden" name="sort" value="${v.sort ?? ''}">

  <details class="filter-panel" ${opts.activeCount > 0 ? raw('open') : null}>
    <summary>
      ${icon('search', 'ico-sm')} Filters
      ${opts.activeCount > 0
        ? html`<span class="amen-count" data-n="${String(opts.activeCount)}">${String(opts.activeCount)}</span>`
        : null}
    </summary>

    <div class="filter-body">
      <div class="filter-row">
        <div class="field">
          <label for="f-mode">Renting or buying</label>
          <select id="f-mode" name="mode">
            <option value="">Either</option>
            <option value="rent" ${v.mode === 'rent' ? raw('selected') : null}>To rent</option>
            <option value="sale" ${v.mode === 'sale' ? raw('selected') : null}>To buy</option>
          </select>
        </div>
        <div class="field">
          <label for="f-minprice">Price from</label>
          <input id="f-minprice" type="number" name="minPrice" min="0" step="50"
                 placeholder="Any" value="${v.minPrice === undefined ? '' : String(v.minPrice)}">
        </div>
        <div class="field">
          <label for="f-maxprice">Price to</label>
          <input id="f-maxprice" type="number" name="maxPrice" min="0" step="50"
                 placeholder="Any" value="${v.maxPrice === undefined ? '' : String(v.maxPrice)}">
        </div>
      </div>

      <div class="filter-row">
        ${minField('minBeds', 'Bedrooms', v.minBeds)}
        ${minField('minBaths', 'Bathrooms', v.minBaths)}
        ${minField('minSqft', 'Square feet', v.minSqft, 50)}
      </div>

      <fieldset class="filter-set">
        <legend class="small">Property type</legend>
        <div class="amen-grid" style="padding-top:4px">
          ${opts.propertyTypes.map((t) => html`
          <label class="amen">
            <input type="checkbox" name="propertyTypes" value="${t}"
                   ${types.has(t) ? raw('checked') : null}>
            <span class="amen-tile">${t.replace(/_/g, ' ')}</span>
            <span class="amen-tick" aria-hidden="true">${icon('check')}</span>
          </label>`)}
        </div>
      </fieldset>

      ${/* The same picker the listing forms use. One definition of what an
            amenity is and how it looks, on both sides of the marketplace. */ null}
      ${amenityPicker(opts.amenityGroups, has, 'Only show listings that have all of these.')}

      <div class="filter-actions">
        <button class="btn btn-primary" type="submit">Show matches</button>
        ${opts.activeCount > 0
          ? html`<a class="btn" href="${opts.clearHref}">Clear filters</a>`
          : null}
      </div>
    </div>
  </details>
</form>`;
}

function minField(name: string, label: string, value: number | undefined, step = 1): Html {
  return html`
<div class="field">
  <label for="f-${name}">${label}</label>
  <input id="f-${name}" type="number" name="${name}" min="0" step="${String(step)}"
         placeholder="Any" value="${value === undefined ? '' : String(value)}">
</div>`;
}

/**
 * The filters currently applied, each one removable.
 *
 * Every chip is a LINK to the same search without that one filter — no script,
 * and each is its own shareable URL. This exists because a collapsed filter
 * panel hides what it is doing: the commonest confusion on any filtered search
 * is an empty result page caused by a filter the person forgot they set three
 * refinements ago.
 */
export function activeFilters(opts: {
  chips: ReadonlyArray<{ label: string; without: string }>;
}): Html {
  if (opts.chips.length === 0) return html``;
  return html`
<div class="chips-row">
  <span class="small muted">Filtering by</span>
  ${opts.chips.map((c) => html`
    <a class="chip chip-tint chip-x" href="${c.without}">
      ${c.label}${icon('x', 'ico-sm')}
    </a>`)}
</div>`;
}
