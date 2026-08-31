/**
 * Account-linking decisions for social login.
 *
 * This file is pure logic with no database and no network, because it encodes
 * the rule that decides whether a stranger gets access to someone else's
 * account. It should be readable, and it should be testable exhaustively.
 *
 * The attack it defends against:
 *
 *   1. Victim has a Portage account, victim@example.com.
 *   2. Attacker creates an account at some OAuth provider and sets the email
 *      to victim@example.com. Weak providers never verify it.
 *   3. Attacker clicks "Sign in with <provider>".
 *   4. A naive implementation matches on the email string and logs the
 *      attacker straight into the victim's account.
 *
 * The defence is to treat the email as a *claim about* an identity rather
 * than an identity, and to auto-link only when both sides are verified.
 */

export type LinkDecision =
  /** Provider account already bound to a user — just sign in. */
  | { action: 'sign_in'; userId: string }
  /** No local account matches; create one. Provider verified the email. */
  | { action: 'create_account' }
  /** Safe to bind this provider account to the existing local account. */
  | { action: 'link_to_existing'; userId: string }
  /**
   * A local account matches the email, but linking automatically would be
   * unsafe. The user must prove control of one side first.
   */
  | { action: 'require_proof'; userId: string; reason: LinkBlockReason }
  /** Refuse outright. */
  | { action: 'reject'; reason: LinkBlockReason };

export type LinkBlockReason =
  | 'provider_email_unverified'
  | 'local_email_unverified'
  | 'account_suspended'
  | 'provider_supplied_no_email'
  | 'already_linked_to_other_user';

export interface ProviderIdentity {
  provider: string;
  providerUserId: string;
  email: string | null;
  /** What the PROVIDER asserted — never inferred from the email string. */
  emailVerified: boolean;
}

export interface LocalAccount {
  userId: string;
  status: 'active' | 'suspended' | 'deleted';
  /** Whether WE have verified this address. */
  emailVerified: boolean;
}

export interface LinkContext {
  identity: ProviderIdentity;
  /** An oauth_identities row already bound to this (provider, subject). */
  existingLink: { userId: string } | null;
  /** A local user whose email equals the provider's email, if any. */
  emailMatch: LocalAccount | null;
  /** Set when the user is already signed in and is linking deliberately. */
  signedInUserId?: string | undefined;
}

export function decideLink(ctx: LinkContext): LinkDecision {
  const { identity, existingLink, emailMatch, signedInUserId } = ctx;

  // 1. Already bound. The provider subject is the identity, so this path does
  //    not consult the email at all — a provider-side email change must not
  //    move an account.
  if (existingLink) {
    if (signedInUserId && signedInUserId !== existingLink.userId) {
      // This provider account belongs to somebody else.
      return { action: 'reject', reason: 'already_linked_to_other_user' };
    }
    return { action: 'sign_in', userId: existingLink.userId };
  }

  // 2. Deliberate linking by an authenticated user. They have already proven
  //    control of the local account by being signed in, so the provider's
  //    email verification status is not load-bearing here.
  if (signedInUserId) {
    return { action: 'link_to_existing', userId: signedInUserId };
  }

  // 3. No email from the provider (Facebook permits this). We cannot match a
  //    local account, and guessing is exactly the bug we are avoiding.
  if (!identity.email) {
    return emailMatch
      ? { action: 'require_proof', userId: emailMatch.userId, reason: 'provider_supplied_no_email' }
      : { action: 'create_account' };
  }

  // 4. No local account with this email — a fresh signup.
  if (!emailMatch) {
    // Still require the provider to have verified it, so an unverified
    // address cannot be planted for a future victim to collide with.
    return identity.emailVerified
      ? { action: 'create_account' }
      : { action: 'reject', reason: 'provider_email_unverified' };
  }

  // 5. A local account matches. This is the dangerous branch.
  if (emailMatch.status !== 'active') {
    return { action: 'reject', reason: 'account_suspended' };
  }
  if (!identity.emailVerified) {
    return {
      action: 'require_proof',
      userId: emailMatch.userId,
      reason: 'provider_email_unverified',
    };
  }
  if (!emailMatch.emailVerified) {
    // The provider vouches for the address, but we never did. An attacker who
    // registered an unverified local account under someone else's address
    // would otherwise be handed it.
    return {
      action: 'require_proof',
      userId: emailMatch.userId,
      reason: 'local_email_unverified',
    };
  }

  // Both sides verified the same address: linking is safe.
  return { action: 'link_to_existing', userId: emailMatch.userId };
}

/** Human-readable explanation for a blocked link, safe to show a user. */
export function explainBlock(reason: LinkBlockReason): string {
  switch (reason) {
    case 'provider_email_unverified':
      return 'Your provider has not verified that email address. Sign in with your password, or verify the address with your provider first.';
    case 'local_email_unverified':
      return 'An account already uses that email address but it has not been verified. Check your inbox for the verification link, then try again.';
    case 'account_suspended':
      return 'That account is not available. Contact support.';
    case 'provider_supplied_no_email':
      return 'Your provider did not share an email address, so we cannot match your existing account. Sign in with your password and link the provider from your profile.';
    case 'already_linked_to_other_user':
      return 'That provider account is already connected to a different Portage account.';
  }
}
