/**
 * The icon set.
 *
 * Inline SVG, defined once per page as a sprite and referenced with `<use>`.
 * That is the whole design: no icon font (which downloads a file to draw a
 * picture, and renders as a box in the gap before it arrives), no CDN (the CSP
 * forbids it, correctly), no <img> per icon (42 requests to draw 42 amenities).
 * The sprite is about 4KB and arrives in the same response as the page.
 *
 * WHY NO `raw()` HERE, which is worth stating because every other place that
 * builds markup from data needs it: path data is digits, letters, commas,
 * dots, spaces and minus signs. None of `<>&"'` occurs in it, so escaping is
 * a no-op and the `html` tag can be used unchanged. The tag structure around
 * it is literal. There is no bypass in this file, and there should never be
 * one — an icon is not user input.
 *
 * The strokes are drawn on a 24x24 grid at width 1.7, which is what makes them
 * look like one family rather than a collection.
 */
import { html, type Html } from './html.js';

type Shape = { d: string } | { c: [number, number, number] };

const ICONS: Record<string, Shape[]> = {
  // ── movement and place ────────────────────────────────────────────────
  car: [
    { d: 'M5 17h14M4 17v-4.2a2 2 0 0 1 .2-.9l1.9-3.8A2 2 0 0 1 7.9 7h8.2a2 2 0 0 1 1.8 1.1l1.9 3.8a2 2 0 0 1 .2.9V17' },
    { c: [7, 17, 1.6] }, { c: [17, 17, 1.6] },
  ],
  garage: [
    { d: 'M3 21V9.5a1 1 0 0 1 .6-.9l8-3.4a1 1 0 0 1 .8 0l8 3.4a1 1 0 0 1 .6.9V21' },
    { d: 'M7 21v-6h10v6M7 18h10' },
  ],
  plug: [
    { d: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6zM12 17v4' },
  ],
  bolt: [{ d: 'M13 2 4.5 13.5H11L10 22l8.5-11.5H12z' }],

  // ── utility rooms ─────────────────────────────────────────────────────
  washer: [
    { d: 'M4 3h16v18H4zM4 7h16' }, { c: [12, 14, 4] }, { c: [7, 5, 0.6] },
  ],
  dish: [
    { d: 'M4 4h16v16H4zM8 8h8v8H8z' },
  ],
  bath: [
    { d: 'M3 12h18v3a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM6 12V6a2 2 0 0 1 4 0M6 21l-1 1M18 21l1 1' },
  ],
  hanger: [
    { d: 'M12 7a2 2 0 1 1 2-2M12 7v2M12 9 4 15.5a1 1 0 0 0 .6 1.8h14.8a1 1 0 0 0 .6-1.8z' },
  ],

  // ── climate ───────────────────────────────────────────────────────────
  flame: [
    { d: 'M12 22a6 6 0 0 0 6-6c0-4-3-5-3-9 0 0-3 1.5-3 5 0-2-1.5-3-1.5-3S6 11 6 16a6 6 0 0 0 6 6z' },
  ],
  snow: [
    { d: 'M12 2v20M4 7l16 10M20 7 4 17M12 6l2.5-2.5M12 6 9.5 3.5M12 18l2.5 2.5M12 18l-2.5 2.5' },
  ],
  thermometer: [
    { d: 'M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z' },
  ],

  // ── outdoors ──────────────────────────────────────────────────────────
  balcony: [
    { d: 'M4 21v-8h16v8M4 17h16M9 13v8M15 13v8M7 13V8a5 5 0 0 1 10 0v5' },
  ],
  tree: [
    { d: 'M12 21v-5M12 16 7.5 12H10L6 7.5h3L12 3l3 4.5h3L14 12h2.5z' },
  ],
  fence: [
    { d: 'M4 21V9l2-3 2 3v12M12 21V9l2-3 2 3v12M20 21V9M2 12h20M2 16h20' },
  ],
  deck: [
    { d: 'M3 20h18M4 20V10M20 20V10M3 10h18l-2-3H5zM9 20v-6M15 20v-6' },
  ],

  // ── the building ──────────────────────────────────────────────────────
  elevator: [
    { d: 'M5 3h14v18H5zM12 3v18M8.5 9 7 7 5.5 9M8.5 15 7 17l-1.5-2M18.5 9 17 7l-1.5 2M18.5 15 17 17l-1.5-2' },
  ],
  accessible: [
    { c: [12, 4.5, 1.6] },
    { d: 'M11 8v5h4.5l2.5 6M11 13a4.5 4.5 0 1 0 4 6.6' },
  ],
  shield: [
    { d: 'M12 3 5 6v5.5c0 4.3 2.9 8.2 7 9.5 4.1-1.3 7-5.2 7-9.5V6z' },
  ],
  bell: [
    { d: 'M6 16V10a6 6 0 0 1 12 0v6l2 3H4zM10 19a2 2 0 0 0 4 0' },
  ],
  bike: [
    { c: [5.5, 17, 3.2] }, { c: [18.5, 17, 3.2] },
    { d: 'M5.5 17 9 8h5l3.5 9M9 8h6M14 8l1.5 4H9' },
  ],
  box: [
    { d: 'M3 8.5 12 4l9 4.5V17L12 21l-9-4V8.5zM3 8.5 12 13l9-4.5M12 13v8' },
  ],
  dumbbell: [
    { d: 'M3 9v6M6 7v10M18 7v10M21 9v6M6 12h12' },
  ],
  waves: [
    { d: 'M2 16c2.5-2 4.5 2 7 0s4.5 2 7 0 4.5 2 6 0M2 10c2.5-2 4.5 2 7 0s4.5 2 7 0 4.5 2 6 0' },
  ],
  sofa: [
    { d: 'M4 12V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4M3 12a2 2 0 0 1 4 0v3h10v-3a2 2 0 0 1 4 0v6H3zM19 18v2M5 18v2' },
  ],
  stairs: [
    { d: 'M3 20h4v-4h4v-4h4V8h4V4' },
  ],

  // ── rules and services ────────────────────────────────────────────────
  paw: [
    { c: [7, 8, 1.9] }, { c: [12, 6, 1.9] }, { c: [17, 8, 1.9] },
    { d: 'M12 11c-3 0-5 2.2-5 4.6C7 18 8.8 19 12 19s5-1 5-3.4C17 13.2 15 11 12 11z' },
  ],
  smoke: [
    { d: 'M3 17h13v3H3zM19 17h2v3h-2M18 8c2 0 2.5 1.5 2.5 3M15 6c2.5 0 3 2 3 3.5' },
  ],
  wifi: [
    { d: 'M2.5 9a15 15 0 0 1 19 0M6 12.5a10 10 0 0 1 12 0M9.5 16a5 5 0 0 1 5 0' },
    { c: [12, 19.5, 0.6] },
  ],
  droplet: [
    { d: 'M12 3s6 6.4 6 10.4A6 6 0 0 1 6 13.4C6 9.4 12 3 12 3z' },
  ],
  bulb: [
    { d: 'M9.5 18h5M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2h5c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z' },
  ],

  // ── the photo grid ────────────────────────────────────────────────────
  star: [
    { d: 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z' },
  ],
  arrowLeft: [{ d: 'M19 12H5M11 6l-6 6 6 6' }],
  arrowRight: [{ d: 'M5 12h14M13 6l6 6-6 6' }],
  trash: [
    { d: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6' },
  ],
  upload: [
    { d: 'M12 15V4M8 8l4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3' },
  ],
  image: [
    { d: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6' }, { c: [8.5, 9, 1.4] },
  ],
  check: [{ d: 'm5 13 4.5 4.5L19 7' }],
  search: [{ c: [11, 11, 6.5] }, { d: 'm16 16 5 5' }],
  x: [{ d: 'M6 6l12 12M18 6 6 18' }],
};

export type IconName = keyof typeof ICONS;

/** True for a name the sprite actually defines. Guards the maps below. */
export function hasIcon(name: string): name is IconName {
  return Object.hasOwn(ICONS, name);
}

/**
 * The sprite. Emit once per page, before anything that references it.
 *
 * `width=0 height=0` rather than `display:none`: a hidden SVG's symbols are
 * still referenceable, but some browsers have historically refused to render
 * `<use>` targets inside a `display:none` ancestor, and this costs nothing.
 */
export function iconSprite(): Html {
  return html`<svg width="0" height="0" aria-hidden="true" focusable="false"
    style="position:absolute"><defs>${Object.entries(ICONS).map(([name, shapes]) => html`
    <symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      ${shapes.map((s) => ('d' in s
        ? html`<path d="${s.d}"/>`
        : html`<circle cx="${String(s.c[0])}" cy="${String(s.c[1])}" r="${String(s.c[2])}"/>`))}
    </symbol>`)}</defs></svg>`;
}

/**
 * One icon.
 *
 * Decorative by default — `aria-hidden`, because every icon here sits beside
 * its own text label and a screen reader announcing "star, Make cover" is
 * reading the same thing twice. An icon used as the ONLY content of a control
 * takes a label on the control, not here.
 */
export function icon(name: IconName, cls = ''): Html {
  return html`<svg class="${cls ? `ico ${cls}` : 'ico'}" aria-hidden="true"
    focusable="false"><use href="#i-${name}"/></svg>`;
}
