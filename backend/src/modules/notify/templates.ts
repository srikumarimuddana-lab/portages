/**
 * Message templates.
 *
 * Versioned in the repository rather than stored in a database, so a change
 * to what users receive goes through code review and ships with a deploy that
 * can be rolled back.
 *
 * Two rules every template follows:
 *
 *  - Substitution ESCAPES by default in the HTML part. A listing title is
 *    user-supplied; putting it into an email unescaped is stored XSS with a
 *    delivery mechanism.
 *  - Every commercial message carries sender identification and an
 *    unsubscribe line. CASL requires both, and the transactional exemption
 *    covers consent, not identification.
 */

export type TemplateId =
  | 'otp_email'
  | 'otp_sms'
  | 'verify_email'
  | 'password_reset'
  | 'saved_search_alert'
  | 'message_received'
  | 'viewing_requested'
  | 'viewing_confirmed'
  | 'listing_approved'
  | 'listing_rejected';

export type TemplateVars = Record<string, string | number | undefined>;

export interface RenderedMessage {
  subject?: string | undefined;
  text: string;
  html?: string | undefined;
}

interface TemplateDef {
  subject?: string;
  text: string;
  html?: string;
  /** Commercial messages get the CASL footer; transactional get identification only. */
  commercial: boolean;
}

const SENDER_BLOCK = 'Portage · Regina, Saskatchewan · portage.ca';

const TEMPLATES: Record<TemplateId, TemplateDef> = {
  otp_email: {
    subject: 'Your Portage verification code',
    text: 'Your Portage code is {{code}}. It expires in {{minutes}} minutes.\n\nIf you did not request this, you can ignore this email.',
    html: '<p>Your Portage code is <strong>{{code}}</strong>.</p><p>It expires in {{minutes}} minutes.</p><p>If you did not request this, you can ignore this email.</p>',
    commercial: false,
  },
  otp_sms: {
    // Kept under 160 characters so it bills as a single segment.
    text: 'Portage code: {{code}}. Expires in {{minutes}} min. Never share it.',
    commercial: false,
  },
  verify_email: {
    subject: 'Confirm your email address',
    text: 'Confirm your email address to finish setting up your Portage account:\n\n{{link}}\n\nThis link expires in {{hours}} hours.',
    html: '<p>Confirm your email address to finish setting up your Portage account.</p><p><a href="{{link}}">Confirm email address</a></p><p>This link expires in {{hours}} hours.</p>',
    commercial: false,
  },
  password_reset: {
    subject: 'Reset your Portage password',
    text: 'Someone asked to reset the password for this account.\n\n{{link}}\n\nThis link expires in {{minutes}} minutes. If it was not you, nothing has changed and you can ignore this email.',
    html: '<p>Someone asked to reset the password for this account.</p><p><a href="{{link}}">Reset password</a></p><p>This link expires in {{minutes}} minutes. If it was not you, nothing has changed and you can ignore this email.</p>',
    commercial: false,
  },
  saved_search_alert: {
    subject: '{{count}} new listings match "{{searchName}}"',
    text: '{{count}} new listings match your saved search "{{searchName}}".\n\n{{link}}',
    html: '<p><strong>{{count}}</strong> new listings match your saved search &ldquo;{{searchName}}&rdquo;.</p><p><a href="{{link}}">View them on Portage</a></p>',
    commercial: true,
  },
  message_received: {
    subject: 'New message about {{listingAddress}}',
    text: 'You have a new message about {{listingAddress}}.\n\n{{link}}\n\nPortage never asks for payment before a viewing. Report anything that looks wrong.',
    html: '<p>You have a new message about {{listingAddress}}.</p><p><a href="{{link}}">Read it on Portage</a></p><p>Portage never asks for payment before a viewing. Report anything that looks wrong.</p>',
    commercial: false,
  },
  viewing_requested: {
    subject: 'Viewing request for {{listingAddress}}',
    text: '{{requesterName}} asked to view {{listingAddress}} on {{when}}.\n\n{{link}}',
    commercial: false,
  },
  viewing_confirmed: {
    subject: 'Your viewing is confirmed',
    text: 'Your viewing of {{listingAddress}} is confirmed for {{when}}.\n\n{{link}}',
    commercial: false,
  },
  listing_approved: {
    subject: 'Your listing is live',
    text: 'Your listing at {{listingAddress}} has been reviewed and is now live on Portage.\n\n{{link}}',
    commercial: false,
  },
  listing_rejected: {
    subject: 'Your listing needs changes',
    text: 'Your listing at {{listingAddress}} could not be published yet.\n\nReason: {{reason}}\n\nYou can edit and resubmit it here: {{link}}',
    commercial: false,
  },
};

export function renderTemplate(id: TemplateId, vars: TemplateVars): RenderedMessage {
  const def = TEMPLATES[id];
  if (!def) throw new Error(`unknown template: ${id}`);

  const text = substitute(def.text, vars, false) + footer(def.commercial, false);
  const out: RenderedMessage = { text };

  if (def.subject) out.subject = substitute(def.subject, vars, false);
  if (def.html) out.html = substitute(def.html, vars, true) + footer(def.commercial, true);
  return out;
}

/**
 * Replaces {{name}} placeholders.
 *
 * `escape` is true for HTML output. A missing variable becomes an empty
 * string rather than leaving "{{name}}" visible in someone's inbox.
 */
function substitute(template: string, vars: TemplateVars, escape: boolean): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) return '';
    const s = String(value);
    return escape ? escapeHtml(s) : s;
  });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function footer(commercial: boolean, html: boolean): string {
  const unsubscribe = commercial
    ? html
      ? '<p><a href="{{unsubscribeUrl}}">Unsubscribe from these alerts</a></p>'
      : '\n\nUnsubscribe: {{unsubscribeUrl}}'
    : '';
  return html
    ? `<hr><p>${SENDER_BLOCK}</p>${unsubscribe}`
    : `\n\n—\n${SENDER_BLOCK}${unsubscribe}`;
}

/** Every template id, for tests and for the admin preview screen. */
export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];

export function isCommercial(id: TemplateId): boolean {
  return TEMPLATES[id].commercial;
}
