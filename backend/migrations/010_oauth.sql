-- 010: social login (Google, Facebook) and email verification.
--
-- Two tables, and the ordering between them matters for security:
--
--   oauth_auth_requests  holds the short-lived PKCE/state material for an
--                        in-flight authorization. Rows are single-use.
--   oauth_identities     binds a provider account to a Portage user.
--
-- The account-linking rule this schema supports is the important part. The
-- classic OAuth takeover is: attacker signs up at the provider with a victim's
-- email address that the provider never verified, logs in via OAuth, and gets
-- auto-linked to the victim's existing account. We therefore record what the
-- provider actually asserted (email_verified_at) rather than trusting the
-- email string, and require BOTH sides verified before an automatic link.

CREATE TABLE oauth_auth_requests (
  -- The `state` parameter, also the primary key. Random, single-use.
  state             text PRIMARY KEY,
  provider          text NOT NULL CHECK (provider IN ('google','facebook')),
  -- SHA-256 of the PKCE verifier. The verifier itself never touches the
  -- database, so a dump cannot be used to complete an in-flight login.
  code_challenge    bytea NOT NULL,
  nonce_hash        bytea NOT NULL,
  -- Where to send the user afterwards. Validated as a relative path before
  -- storage — an open redirect here would be a phishing primitive.
  redirect_path     text NOT NULL DEFAULT '/',
  -- Set when this request is being used to link a provider to an account the
  -- user is already signed in to, rather than to sign in.
  linking_user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz
);
CREATE INDEX oauth_auth_requests_expiry_idx ON oauth_auth_requests(expires_at);

CREATE TABLE oauth_identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('google','facebook')),
  -- The provider's stable subject identifier. NOT the email: emails change
  -- hands, `sub` does not.
  provider_user_id  text NOT NULL,
  email             citext,
  -- When the PROVIDER asserted the email was verified. NULL means it did not.
  email_verified_at timestamptz,
  linked_at         timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz
);

-- One provider account maps to exactly one Portage user.
CREATE UNIQUE INDEX oauth_identities_provider_subject_idx
  ON oauth_identities(provider, provider_user_id);
-- A user may link at most one account per provider.
CREATE UNIQUE INDEX oauth_identities_user_provider_idx
  ON oauth_identities(user_id, provider);

-- Email verification challenges, and the same table backs OTP sign-in.
-- Codes are hashed at rest, exactly like session tokens: a database dump must
-- not hand an attacker a working code.
CREATE TABLE otp_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  -- Present for sign-in flows where no account exists yet.
  identifier    citext NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('email','sms')),
  purpose       text NOT NULL CHECK (purpose IN
                ('verify_email','verify_phone','sign_in','password_reset','link_account')),
  code_hash     bytea NOT NULL,
  attempts      smallint NOT NULL DEFAULT 0,
  max_attempts  smallint NOT NULL DEFAULT 5,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  CONSTRAINT otp_attempts_bounded CHECK (attempts <= max_attempts)
);
-- Only one live challenge per identifier+purpose: requesting a new code
-- invalidates the previous one rather than giving an attacker parallel guesses.
CREATE UNIQUE INDEX otp_live_challenge_idx
  ON otp_challenges(identifier, purpose) WHERE consumed_at IS NULL;
CREATE INDEX otp_expiry_idx ON otp_challenges(expires_at);
