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
export function amenityPicker(groups: readonly AmenityGroup[], has: ReadonlySet<string>): Html {
  const chosen = groups.reduce(
    (n, g) => n + g.items.filter((i) => has.has(i.key)).length, 0,
  );

  return html`
<fieldset class="field" data-amenities
          style="border:1px solid var(--line);border-radius:10px;padding:14px 14px 16px">
  <legend class="small" style="font-weight:600;padding:0 6px">Amenities</legend>

  <div class="amen-head">
    <span class="small muted">
      Tick everything the property actually has.
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
