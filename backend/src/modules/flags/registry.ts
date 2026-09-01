/**
 * The flag registry.
 *
 * Every switch that exists, declared in code rather than in the database.
 * Two reasons, and the second is the one that matters:
 *
 *  1. A closed union means a typo'd key is a compile error rather than a
 *    check that silently returns the wrong answer. `isEnabled('chanel.email')`
 *    must not quietly report "on" forever.
 *
 *  2. THE FAIL-SAFE DEFAULT HAS TO BE READABLE WHEN THE DATABASE IS NOT.
 *    That is the entire situation it exists for. A default stored in
 *    `feature_flags` is unavailable in exactly the outage it was meant to
 *    cover, so it lives here.
 *
 * The database holds current state; this file holds what a flag IS. Adding a
 * flag is a code change and needs no migration.
 */

/** Kill switches turn an existing capability off. Rollouts turn a new one on. */
export type FlagTier = 'kill_switch' | 'rollout';

export interface FlagDefinition {
  /** Shown in the admin console. Written for someone deciding at 3am. */
  readonly label: string;
  readonly tier: FlagTier;
  /**
   * The value used when `feature_flags` cannot be read AND no recent snapshot
   * is held — see service.ts for the grace window between those two states.
   *
   * The asymmetry is deliberate and is the whole safety argument. An hour of
   * no email is an inconvenience. An hour of a runaway send is a suppression
   * list and a sender reputation that does not come back. Browsing and login
   * fail OPEN for the mirror reason: a database blip must not take the public
   * site down, and neither can run up a bill.
   */
  readonly failsafe: boolean;
  /** What breaks when this is off. Shown next to the switch. */
  readonly effect: string;
}

export const FLAGS = {
  // ── outbound channels ──────────────────────────────────────────────────
  // Checked by NotifyService.send() before any database work, so a thrown
  // switch costs one cached boolean rather than a delivery row.
  'channel.email': {
    label: 'Email sending',
    tier: 'kill_switch',
    failsafe: false,
    effect: 'No email leaves the system. Enquiry notifications, OTP codes and password resets are all recorded as blocked.',
  },
  'channel.sms': {
    label: 'SMS sending',
    tier: 'kill_switch',
    failsafe: false,
    effect: 'No SMS leaves the system. SMS OTP stops working; email OTP is unaffected.',
  },
  'channel.whatsapp': {
    label: 'WhatsApp sending',
    tier: 'kill_switch',
    failsafe: false,
    effect: 'No WhatsApp messages. The adapter is a stub today, so this is off in practice regardless.',
  },

  // ── AI ─────────────────────────────────────────────────────────────────
  // Declared before the features exist, deliberately. A switch added at the
  // same time as the feature it guards is a switch nobody has ever tested;
  // these are checked by FlagService from day one and the call sites land
  // against a seam that already works.
  'ai.chat_search': {
    label: 'AI chat search',
    tier: 'kill_switch',
    failsafe: false,
    effect: 'Natural-language search falls back to the ordinary filter UI. Structured search is unaffected.',
  },
  'ai.listing_builder': {
    label: 'AI listing descriptions',
    tier: 'kill_switch',
    failsafe: false,
    effect: 'Owners write their own descriptions. Existing AI descriptions and their attestations are untouched.',
  },
  'ai.moderation': {
    label: 'AI moderation',
    tier: 'kill_switch',
    failsafe: false,
    effect: 'Falls back to the rule-based scanner in messaging/policy.ts, which is what runs today anyway.',
  },

  // ── signup and content creation ────────────────────────────────────────
  // Fail OPEN: these are the product. A database blip that stops people using
  // the site is a worse outcome than the abuse these guard against, which
  // rate limiting already covers on its own.
  'signups.new': {
    label: 'New signups',
    tier: 'kill_switch',
    failsafe: true,
    effect: 'Registration is closed. Existing accounts log in normally.',
  },
  'listings.new': {
    label: 'New listings',
    tier: 'kill_switch',
    failsafe: true,
    effect: 'No new listings can be created. Editing and publishing existing ones still works.',
  },
  'uploads.new': {
    label: 'Photo and document uploads',
    tier: 'kill_switch',
    failsafe: true,
    effect: 'No new upload tickets are issued. Uploads already in flight complete; existing files are still served.',
  },

  // ── OAuth, per provider ────────────────────────────────────────────────
  // Per provider rather than one switch, because the failure that calls for
  // this is one provider's outage or a leaked client secret, and taking down
  // the other login route with it helps nobody.
  'oauth.google': {
    label: 'Sign in with Google',
    tier: 'kill_switch',
    failsafe: true,
    effect: 'The Google button is refused. Password and other providers are unaffected.',
  },
  'oauth.facebook': {
    label: 'Sign in with Facebook',
    tier: 'kill_switch',
    failsafe: true,
    effect: 'The Facebook button is refused. Password and other providers are unaffected.',
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof FLAGS;

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

export function isFlagKey(key: string): key is FlagKey {
  return Object.hasOwn(FLAGS, key);
}

/**
 * The state a flag has when nothing has ever been written for it.
 *
 * A kill switch has not been thrown, so it is on. A rollout has not been
 * started, so it is off at 0%. This is NOT the same as `failsafe`, which is
 * about the database being unreadable — a distinction worth keeping straight,
 * because conflating them makes an unseeded kill switch default to off and
 * takes email down the first time the table is empty.
 */
export function defaultStateOf(key: FlagKey): { enabled: boolean; rolloutPct: number } {
  return FLAGS[key].tier === 'kill_switch'
    ? { enabled: true, rolloutPct: 100 }
    : { enabled: false, rolloutPct: 0 };
}
