/**
 * HTML templating.
 *
 * One job, and it is the same job `search/query.ts` does for SQL: make the
 * dangerous thing structurally impossible rather than a review checklist item.
 *
 * THE RULE. `html` is a tagged template. Every interpolated value is escaped
 * on the way in. There is no way to build a page except through it, and the
 * only way to insert markup you built yourself is `raw()`, which is greppable
 * — so "where could XSS come from" has an answer you can enumerate rather
 * than an answer you have to trust.
 *
 * That matters more here than on most sites. A listing title, a description,
 * a message body and a person's display name are all written by members of
 * the public, and all four end up on a page. A single unescaped one is a
 * stored XSS on a page that other people's browsers load while signed in.
 *
 * Why not a library: the same reason as everywhere else in this codebase —
 * npm is unavailable in the environment this was built in, and the whole of
 * this file is forty lines that can be read in a minute and tested exactly.
 */

/** Markup that has already been escaped, or was never user data. */
export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

/**
 * The five characters that change meaning inside markup.
 *
 * Quotes are escaped as well as the tag characters, because an interpolation
 * lands in an attribute at least as often as in a text node — `title="${x}"`
 * is the common case, and escaping only `<` and `&` leaves it wide open.
 */
export function escape(input: unknown): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Marks a string as safe. Every call is a place XSS could come from.
 *
 * Reserved for markup this codebase built — never for anything that reached
 * us from a request, a database row, or a model.
 */
export function raw(value: string): Html {
  return new Html(value);
}

/**
 * The template tag. Escapes every interpolation unless it is already `Html`.
 *
 * `null` and `undefined` render as nothing rather than as the strings "null"
 * and "undefined", because an absent middle name should be absent, and an
 * array renders by joining — so `${items.map(row)}` works without a `.join('')`
 * that is easy to forget and silently produces a comma-separated page.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? '');
  }
  return new Html(out);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escape(value);
}

/**
 * A URL safe to put in `href`.
 *
 * Escaping alone does not make a link safe: `javascript:alert(1)` contains no
 * character this function's cousin would touch, and it executes on click.
 * Only same-origin paths and http(s) links are allowed through; anything else
 * becomes '#'.
 */
export function safeUrl(input: unknown): string {
  const s = String(input ?? '').trim();
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return '#';
}

/** Renders `class="a b"` from a set of conditions, skipping the falsy ones. */
export function classes(...names: Array<string | false | null | undefined>): Html {
  const list = names.filter(Boolean).join(' ');
  return list ? raw(` class="${escape(list)}"`) : raw('');
}

/**
 * JSON destined for a `<script type="application/json">` block.
 *
 * `</script>` inside a string value would close the block early and turn the
 * rest of the payload into markup, so the sequence is broken at the one place
 * it can appear. Not theoretical: a listing titled `</script><img onerror=...>`
 * is exactly the shape of the attack.
 */
export function jsonScript(value: unknown): Html {
  return raw(
    JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026'),
  );
}
