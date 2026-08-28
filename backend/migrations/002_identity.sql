-- 002: identity, sessions, verification, consent.

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  phone          text,
  -- scrypt hash, encoded "scrypt$N$r$p$salt_b64$hash_b64". Never plaintext.
  password_hash  text NOT NULL,
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','suspended','deleted')),
  role           text NOT NULL DEFAULT 'user'
                 CHECK (role IN ('user','staff','admin')),
  failed_logins  integer NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  email_verified_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_profiles (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name        text,
  preferred_cities text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_profiles_updated BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sessions store only a SHA-256 hash of the opaque token. A database leak
-- therefore does not yield usable session cookies.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  csrf_hash     bytea NOT NULL,
  user_agent    text,
  ip_hash       bytea,               -- hashed, not raw IP (data minimization)
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions(absolute_expires_at);

-- Identity verification. NOTE: there is deliberately NO column for the ID
-- image or document number. The OPC advises that copying government ID
-- "should not be a standard operating practice" and has found indefinite
-- retention of ID data to violate PIPEDA. We keep only the verdict, the
-- provider reference, and a salted hash for audit correlation.
CREATE TABLE verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('email','phone','id_document')),
  status        text NOT NULL CHECK (status IN ('pending','passed','failed','expired')),
  provider      text,
  provider_ref  text,
  result_hash   bytea,
  verified_at   timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX verifications_user_kind_idx ON verifications(user_id, kind);
CREATE TRIGGER verifications_updated BEFORE UPDATE ON verifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- CASL consent ledger. The notify module refuses to send unless a live row
-- exists here. Penalties reach $10M per violation, so consent is data, not a
-- boolean on a profile.
CREATE TABLE consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('saved_search_alert','marketing','transactional')),
  channel     text NOT NULL CHECK (channel IN ('email','sms','push')),
  method      text NOT NULL CHECK (method IN ('express_optin','implied_inquiry','implied_transaction')),
  evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX consents_lookup_idx ON consents(user_id, kind, channel)
  WHERE revoked_at IS NULL;
