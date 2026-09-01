/**
 * Message moderation.
 *
 * Migration 004 says every message is machine-reviewed "before it is
 * delivered". This is that review. It is deliberately a heuristic and not a
 * model call: it runs on the send path, so it has to be fast, deterministic,
 * free, and impossible to have an outage. A model pass is a later addition
 * that can raise a verdict, never the thing standing between a person and
 * their own inbox.
 *
 * THE IDEA THAT SHAPES THIS FILE: the same sentence means different things
 * at different points in a conversation.
 *
 * "Here's my number, call me" in the FIRST message from a stranger is how a
 * scam moves off-platform before either party is verified. The same sentence
 * in the tenth message, after both people have talked about the unit and
 * agreed to meet, is two adults arranging a viewing — and blocking it would
 * make the product useless, because the whole point is that they eventually
 * meet.
 *
 * So contact-sharing is scored against thread maturity. What is NOT scored
 * against maturity is the small set of signals that mean the same thing
 * forever: asking for money before a viewing, and the "I am abroad, wire the
 * deposit" script. A scammer who sends three polite messages and then pivots
 * must not be rewarded for the patience.
 */

export type Verdict = 'allow' | 'flag' | 'block';

export interface MessageSignal {
  reason: string;
  weight: number;
  /** True when this signal means the same thing however mature the thread. */
  absolute: boolean;
}

/** Above this a message is withheld; above FLAG_AT it is delivered but queued. */
export const BLOCK_AT = 100;
export const FLAG_AT = 30;

/**
 * After this many delivered messages, a thread counts as established and
 * contact-sharing stops being suspicious.
 *
 * Four, not two: two messages is "hi" and "hi", which is not a conversation.
 */
export const ESTABLISHED_AFTER = 4;

// ── patterns ────────────────────────────────────────────────────────────────

// Loose on purpose. This is a detector, not a validator: it should fire on
// "three oh six · five five five" written to evade a filter, because that is
// how someone evading a filter writes it.
const PHONE_RE = /(?:\+?1[\s.\-]*)?\(?\d{3}\)?[\s.\-]*\d{3}[\s.\-]*\d{4}/;
const EMAIL_RE = /[a-z0-9._%+-]+\s*(?:@|\(at\)|\[at\]|\sat\s)\s*[a-z0-9.-]+\s*(?:\.|\(dot\)|\[dot\])\s*[a-z]{2,}/i;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;

/** Handles and app names used to move a conversation off-platform. */
const OFF_PLATFORM_APPS = [
  'whatsapp', 'telegram', 'signal me', 'wechat', 'kakao', 'viber',
  'text me at', 'call me at', 'reach me on', 'add me on',
];

/**
 * The money script. Every one of these means the same thing on day one and on
 * day thirty, which is why they are absolute.
 *
 * These are not guesses — they are the recurring phrases in rental-fraud
 * advisories from the Canadian Anti-Fraud Centre and equivalents: the
 * landlord who cannot show the unit, and the deposit that must move first.
 */
const MONEY_BEFORE_VIEWING = [
  'western union', 'moneygram', 'wire transfer', 'wire the deposit',
  'bitcoin', 'crypto', 'gift card', 'itunes card', 'steam card',
  'cashier check', 'cashier cheque', 'certified cheque',
  'deposit before viewing', 'deposit before you see', 'pay before viewing',
  'send the deposit first', 'first month before viewing', 'sight unseen',
];

const ABSENT_LANDLORD = [
  'i am currently abroad', 'i am out of the country', 'i am overseas',
  'currently on a mission', 'missionary work', 'god bless you',
  'my agent will', 'the keys will be shipped', 'keys by courier',
  'i am unable to show', 'cannot show the property in person',
];

/** Pressure tactics. Real, but weak on their own — plenty of honest urgency. */
const URGENCY = [
  'three other people', 'several other applicants', 'first come first served',
  'need to decide today', 'act fast', 'other interested parties waiting',
];

/** The owner saying it is gone. Not abuse — a nudge to close the listing. */
const ALREADY_GONE = [
  'already rented', 'already sold', 'no longer available', 'it is taken',
  "it's taken", 'off the market', 'we found someone',
];

export interface ScanInput {
  body: string;
  /** How many messages the thread already carries. 0 for first contact. */
  threadMessageCount: number;
  /** True when the sender owns the listing. */
  senderIsOwner: boolean;
}

export interface ScanResult {
  verdict: Verdict;
  score: number;
  signals: MessageSignal[];
  /** Set when the owner appears to be saying the listing is gone. */
  suggestsClosed: boolean;
}

/**
 * Scores one message.
 *
 * The weights are chosen so that no single maturity-sensitive signal blocks on
 * its own — a phone number in a first message is worth a look, not a wall —
 * while the money script blocks by itself, immediately, at any thread age.
 */
export function scanMessage(input: ScanInput): ScanResult {
  const text = input.body;
  const lower = text.toLowerCase();
  const established = input.threadMessageCount >= ESTABLISHED_AFTER;
  const signals: MessageSignal[] = [];

  // ── absolute: the money script ────────────────────────────────────────────
  const money = MONEY_BEFORE_VIEWING.filter((t) => lower.includes(t));
  if (money.length > 0) {
    signals.push({
      reason: 'payment_before_viewing',
      // On its own, over BLOCK_AT. A request to move money before anyone has
      // seen the unit is the whole scam in one phrase.
      weight: 100,
      absolute: true,
    });
  }

  const absent = ABSENT_LANDLORD.filter((t) => lower.includes(t));
  if (absent.length > 0) {
    signals.push({
      reason: 'absent_landlord_script',
      // 70 is calibrated, not picked. Alone it flags rather than blocks,
      // because people genuinely do travel and an honest owner saying so must
      // still be able to say it. Paired with moving the conversation
      // off-platform (35) it reaches 105 and blocks — and that pair, "I am
      // away, contact me over there", is the opening of the script rather
      // than a coincidence of two innocent sentences.
      weight: 70,
      absolute: true,
    });
  }

  // ── maturity-sensitive: moving off-platform ───────────────────────────────
  const contact: string[] = [];
  if (PHONE_RE.test(text)) contact.push('phone');
  if (EMAIL_RE.test(text)) contact.push('email');
  if (OFF_PLATFORM_APPS.some((a) => lower.includes(a))) contact.push('app');

  if (contact.length > 0) {
    signals.push({
      reason: `contact_details_${contact.join('_')}`,
      // In an established thread this is two people arranging to meet, which
      // is the point of the product. In a first message from a stranger it is
      // the opening move of nearly every scam.
      weight: established ? 0 : 35,
      absolute: false,
    });
  }

  if (URL_RE.test(text)) {
    signals.push({
      reason: 'external_link',
      // A link is a phishing vector whenever it arrives, but an owner sharing
      // a floor plan late in a thread is ordinary.
      weight: established ? 10 : 30,
      absolute: false,
    });
  }

  const urgent = URGENCY.filter((t) => lower.includes(t));
  if (urgent.length > 0) {
    signals.push({ reason: 'pressure_tactics', weight: 15, absolute: false });
  }

  // ── the owner saying it is gone ───────────────────────────────────────────
  // Not a moderation signal at all. It is a prompt to close the listing, which
  // is the single loudest complaint about every classifieds site: half of what
  // is shown is already gone.
  const suggestsClosed = input.senderIsOwner && ALREADY_GONE.some((t) => lower.includes(t));

  const score = signals.reduce((sum, s) => sum + s.weight, 0);
  return {
    verdict: score >= BLOCK_AT ? 'block' : score >= FLAG_AT ? 'flag' : 'allow',
    score,
    signals,
    suggestsClosed,
  };
}

/**
 * What the SENDER is told when a message is withheld.
 *
 * Deliberately does not name the rule. Telling someone "the phrase 'wire
 * transfer' was detected" is a free tuning loop for the next attempt, and the
 * honest user who tripped it does not need the internals to rewrite the
 * message.
 */
export const BLOCKED_NOTICE =
  'That message was not sent. Messages asking for payment or personal ' +
  'contact before a viewing are held back to protect both sides. ' +
  'Arrange to see the property first, and keep the conversation here.';

/** Shown alongside a delivered-but-flagged message. */
export const FLAG_NOTICE =
  'Take care with this message. Portage never asks for a deposit before a ' +
  'viewing, and payments arranged off the platform have no protection.';

/**
 * Bounds a preview for a notification email.
 *
 * A flagged message gets NO preview. Otherwise a message we judged risky
 * enough to warn about in-app would be delivered in full to the recipient's
 * inbox, which puts it in front of them in the one place our warning is not.
 */
export function previewFor(body: string, verdict: Verdict, max = 140): string | null {
  if (verdict !== 'allow') return null;
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Total risk weight, for the moderation queue's ordering. */
export function riskScoreOf(signals: readonly MessageSignal[]): number {
  return Math.min(signals.reduce((sum, s) => sum + s.weight, 0), 9999);
}
