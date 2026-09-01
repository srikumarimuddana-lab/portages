/**
 * The report form.
 *
 * "Report this listing" has been linked from every live listing page, directly
 * under the anti-fraud warning, since that page was built — and it pointed at
 * a route that did not exist. The `POST /reports` handler, the ReportService,
 * the severity weighting and the moderation queue behind it were all built and
 * tested; only the page a person actually uses was missing, so the link 404ed.
 *
 * That is the worst place in the product for a dead link. It sits beside the
 * sentence telling people never to send money before viewing a property, which
 * is to say it is the control offered to somebody who has just realised they
 * are being defrauded.
 */
import { html } from './html.js';
import { page, csrfField, money, type Flash, type Viewer } from './layout.js';

/**
 * Wording matters more here than anywhere else on the site.
 *
 * Each option says what the reporter observed, not what we would conclude
 * from it. Someone reporting a scam is frightened and in a hurry; someone
 * reporting a rented flat is being helpful. The list is ordered by urgency so
 * the frightened person's option is the first one they see.
 */
const KIND_COPY: Record<string, { label: string; hint: string }> = {
  scam: {
    label: 'It looks like a scam',
    hint: 'Asking for a deposit or e-transfer before a viewing, refusing to '
      + 'meet, or claiming to be out of the country.',
  },
  misleading: {
    label: 'The details are wrong',
    hint: 'The price, size, address or amenities do not match the property.',
  },
  already_rented: {
    label: 'It is already rented or sold',
    hint: 'Not a complaint about the owner — this just keeps the site current.',
  },
  offensive: {
    label: 'The content is offensive',
    hint: 'Discriminatory wording, harassment, or anything that should not be here.',
  },
  duplicate: {
    label: 'It is posted more than once',
    hint: 'The same property listed twice, by the same person or by different ones.',
  },
  other: {
    label: 'Something else',
    hint: 'Tell us below.',
  },
};

export function reportListingPage(opts: Flash & {
  viewer: Viewer;
  listing: { id: string; title: string; priceCents: number; mode: string; addressLine: string; city: string };
  kinds: readonly string[];
  /** Where to send the reporter afterwards. Same-origin only. */
  from: string;
}): string {
  const l = opts.listing;
  return page(
    {
      title: `Report: ${l.title}`,
      viewer: opts.viewer,
      path: '/reports/new',
      notice: opts.notice,
      error: opts.error,
    },
    html`
<div class="wrap" style="max-width:560px;padding:40px 20px 60px">
  <p class="small"><a href="/listings/${l.id}">← Back to the listing</a></p>
  <h1>Report this listing</h1>

  <div style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:16px 0 22px">
    <strong>${l.title}</strong>
    <p class="small muted" style="margin:2px 0 0">
      ${l.addressLine}, ${l.city} · ${money(l.priceCents)}${l.mode === 'rent' ? '/mo' : ''}
    </p>
  </div>

  ${/* Said up front, because the two questions a reporter has are "will they
        know it was me" and "does anyone actually read this". */ null}
  <p class="small muted">
    A moderator reads every report. The owner is never told who reported them.
    Reporting does not take a listing down on its own — several reports, or one
    serious one, put it in front of a person.
  </p>

  <form method="post" action="/reports?from=${opts.from}" class="stack" style="margin-top:20px">
    ${csrfField(opts.viewer)}
    <input type="hidden" name="subjectId" value="${l.id}">

    <fieldset style="border:0;padding:0;margin:0">
      <legend class="small" style="font-weight:600;margin-bottom:8px">
        What is wrong with it?
      </legend>
      ${opts.kinds.map((k, i) => html`
      <label style="display:flex;gap:10px;align-items:flex-start;font-weight:400;
                    border:1px solid var(--line-2);border-radius:10px;
                    padding:11px 13px;margin-bottom:8px;cursor:pointer">
        <input type="radio" name="kind" value="${k}" style="width:auto;margin-top:3px"
               ${i === 0 ? html`required` : null}>
        <span>
          <strong style="font-weight:600;font-size:14px">
            ${KIND_COPY[k]?.label ?? k.replace(/_/g, ' ')}
          </strong>
          <span class="small muted" style="display:block;margin-top:2px">
            ${KIND_COPY[k]?.hint ?? ''}
          </span>
        </span>
      </label>`)}
    </fieldset>

    <div class="field">
      <label for="detail">Anything else? (optional)</label>
      <textarea id="detail" name="detail" rows="4" maxlength="2000"
        placeholder="What happened, and when."></textarea>
      <p class="small muted" style="margin:6px 0 0">
        If money has already changed hands, report it to the Regina Police
        Service as well. We can take a listing down; we cannot get money back.
      </p>
    </div>

    <button class="btn btn-primary" type="submit" style="width:100%">Send the report</button>
  </form>
</div>`,
  );
}
