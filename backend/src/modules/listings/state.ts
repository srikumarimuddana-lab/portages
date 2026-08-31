/**
 * The listing publish state machine.
 *
 * Pure — no database, no I/O — so every transition can be tested directly and
 * the rules are readable in one screen. The service consults this before it
 * writes; the `status` CHECK in migration 003 and the `listings_publish_guard`
 * trigger in 006 are the backstop if it ever forgets.
 *
 * Two things this encodes that a status column alone cannot:
 *
 *  - WHO may make each move. An owner may pause their own listing; only staff
 *    may approve one. Without this, "update the status field" is an API for
 *    self-approval, which makes the moderation queue decorative.
 *
 *  - Which closing state a listing may reach, given its mode. A rental cannot
 *    be marked sold and a sale cannot be marked rented — a listing that
 *    claims to be both is the shape of a bait posting.
 */

export const LISTING_STATUSES = [
  'draft',
  'pending_review',
  'live',
  'paused',
  'rejected',
  'rented',
  'sold',
  'expired',
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const LISTING_MODES = ['sale', 'rent'] as const;
export type ListingMode = (typeof LISTING_MODES)[number];

/**
 * Who is asking. `system` is the scheduled job runner and internal callers
 * (expiry, re-review after a flagged edit) — never a value taken from a
 * request.
 */
export type Actor = 'owner' | 'staff' | 'system';

/** The moves an owner or staff member can name in a request. */
export const LISTING_ACTIONS = [
  'submit',
  'withdraw',
  'approve',
  'reject',
  'pause',
  'resume',
  'close',
  'revise',
] as const;
export type ListingAction = (typeof LISTING_ACTIONS)[number];

interface Transition {
  from: ListingStatus;
  to: ListingStatus;
  actors: readonly Actor[];
  /** Only valid for a listing in this mode. */
  mode?: ListingMode;
  /** The action name a client uses to request this move, if any. */
  action?: ListingAction;
}

/**
 * Every legal move. Anything not listed here is illegal — the table is the
 * allowlist, so a new status cannot quietly become reachable.
 */
export const TRANSITIONS: readonly Transition[] = [
  // Owner puts a draft in front of moderation.
  { from: 'draft', to: 'pending_review', actors: ['owner'], action: 'submit' },
  // ...and can pull it back while it waits.
  { from: 'pending_review', to: 'draft', actors: ['owner'], action: 'withdraw' },

  // Moderation decides. Staff only — this is the whole point of the queue.
  { from: 'pending_review', to: 'live', actors: ['staff'], action: 'approve' },
  { from: 'pending_review', to: 'rejected', actors: ['staff'], action: 'reject' },

  // Owner controls visibility of a live listing.
  { from: 'live', to: 'paused', actors: ['owner'], action: 'pause' },
  { from: 'paused', to: 'live', actors: ['owner'], action: 'resume' },

  // Closing out. Mode-bound: a rental is rented, a sale is sold.
  { from: 'live', to: 'rented', actors: ['owner'], mode: 'rent', action: 'close' },
  { from: 'live', to: 'sold', actors: ['owner'], mode: 'sale', action: 'close' },
  { from: 'paused', to: 'rented', actors: ['owner'], mode: 'rent', action: 'close' },
  { from: 'paused', to: 'sold', actors: ['owner'], mode: 'sale', action: 'close' },

  // Staff can take down something already public.
  { from: 'live', to: 'rejected', actors: ['staff'], action: 'reject' },
  { from: 'paused', to: 'rejected', actors: ['staff'], action: 'reject' },

  // A rejected listing is not a dead end — the owner edits and tries again.
  { from: 'rejected', to: 'draft', actors: ['owner'], action: 'revise' },
  { from: 'expired', to: 'draft', actors: ['owner'], action: 'revise' },

  // System moves. No client can request these; there is no action name.
  { from: 'live', to: 'expired', actors: ['system'] },
  { from: 'paused', to: 'expired', actors: ['system'] },
  // A material edit to a live listing sends it back through moderation. This
  // is the bait-and-switch defence: publish something clean, get approved,
  // then edit it into a scam. See policy.rescanRequired().
  { from: 'live', to: 'pending_review', actors: ['system'] },
];

/** `rented` and `sold` are terminal. Relisting means a new listing. */
export const TERMINAL_STATUSES: readonly ListingStatus[] = ['rented', 'sold'];

/** Statuses the public can see. Everything else is owner- and staff-only. */
export const PUBLIC_STATUSES: readonly ListingStatus[] = ['live'];

export type TransitionVerdict =
  | { ok: true; to: ListingStatus }
  | { ok: false; reason: 'terminal' | 'no_such_transition' | 'wrong_actor' | 'wrong_mode' };

/**
 * Decides whether `actor` may move a listing from `from` to `to`.
 *
 * The reasons are distinguished for the caller's benefit, not the client's:
 * `wrong_actor` and `no_such_transition` both become the same message at the
 * HTTP layer, because telling a stranger "you are not staff" is more than
 * they need to know.
 */
export function canTransition(
  from: ListingStatus,
  to: ListingStatus,
  actor: Actor,
  mode: ListingMode,
): TransitionVerdict {
  if (TERMINAL_STATUSES.includes(from)) return { ok: false, reason: 'terminal' };

  const candidates = TRANSITIONS.filter((t) => t.from === from && t.to === to);
  if (candidates.length === 0) return { ok: false, reason: 'no_such_transition' };

  // Mode is checked before actor so a rental owner asking to mark it "sold"
  // is told the truth rather than being told they lack permission.
  const modeOk = candidates.filter((t) => t.mode === undefined || t.mode === mode);
  if (modeOk.length === 0) return { ok: false, reason: 'wrong_mode' };

  const allowed = modeOk.some((t) => t.actors.includes(actor));
  if (!allowed) return { ok: false, reason: 'wrong_actor' };

  return { ok: true, to };
}

/**
 * Resolves a client-supplied action name to its target status.
 *
 * Clients name an ACTION ("close"), never a target status ("sold"). That is
 * deliberate: it means a request cannot ask for a status that no transition
 * out of the current one produces, and it keeps mode-specific outcomes —
 * rented vs sold — a server decision rather than a client claim.
 */
export function resolveAction(
  action: ListingAction,
  from: ListingStatus,
  actor: Actor,
  mode: ListingMode,
): TransitionVerdict {
  if (TERMINAL_STATUSES.includes(from)) return { ok: false, reason: 'terminal' };

  const candidates = TRANSITIONS.filter((t) => t.action === action && t.from === from);
  if (candidates.length === 0) return { ok: false, reason: 'no_such_transition' };

  const modeOk = candidates.filter((t) => t.mode === undefined || t.mode === mode);
  if (modeOk.length === 0) return { ok: false, reason: 'wrong_mode' };

  const permitted = modeOk.find((t) => t.actors.includes(actor));
  if (!permitted) return { ok: false, reason: 'wrong_actor' };

  return { ok: true, to: permitted.to };
}

/** The actions this actor could take right now. Drives the owner's UI. */
export function availableActions(
  from: ListingStatus,
  actor: Actor,
  mode: ListingMode,
): ListingAction[] {
  if (TERMINAL_STATUSES.includes(from)) return [];
  const out = new Set<ListingAction>();
  for (const t of TRANSITIONS) {
    if (t.from !== from || !t.action) continue;
    if (t.mode !== undefined && t.mode !== mode) continue;
    if (!t.actors.includes(actor)) continue;
    out.add(t.action);
  }
  return [...out];
}

/** True when the status makes the listing visible to anyone but its owner. */
export function isPublic(status: ListingStatus): boolean {
  return PUBLIC_STATUSES.includes(status);
}
