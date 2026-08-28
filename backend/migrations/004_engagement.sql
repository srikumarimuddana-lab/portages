-- 004: saved items, alerts, threads, messages, viewings.

CREATE TABLE saved_listings (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_id)
);

CREATE TABLE saved_searches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  query         jsonb NOT NULL,
  frequency     text NOT NULL DEFAULT 'daily'
                CHECK (frequency IN ('instant','daily','weekly')),
  alert_enabled boolean NOT NULL DEFAULT false,
  -- An alert may only be enabled while a matching consent row is live.
  consent_id    uuid REFERENCES consents(id) ON DELETE SET NULL,
  last_run_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_requires_consent
    CHECK (alert_enabled = false OR consent_id IS NOT NULL)
);
CREATE INDEX saved_searches_user_idx ON saved_searches(user_id);
CREATE TRIGGER saved_searches_updated BEFORE UPDATE ON saved_searches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE threads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inquirer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','archived','blocked')),
  last_at     timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT thread_parties_differ CHECK (owner_id <> inquirer_id)
);
CREATE UNIQUE INDEX threads_unique_idx ON threads(listing_id, inquirer_id);
CREATE INDEX threads_owner_idx ON threads(owner_id, last_at DESC);
CREATE INDEX threads_inquirer_idx ON threads(inquirer_id, last_at DESC);

CREATE TABLE messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  kind       text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','voice','system')),
  -- B2: every message is machine-reviewed for scam/off-platform-payment
  -- steering and "already rented" signals before it is delivered.
  moderation_verdict text NOT NULL DEFAULT 'pending'
                CHECK (moderation_verdict IN ('pending','allow','flag','block')),
  moderation_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread_idx ON messages(thread_id, created_at);
CREATE INDEX messages_moderation_idx ON messages(moderation_verdict)
  WHERE moderation_verdict = 'pending';

CREATE TABLE viewings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id   uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot_start   timestamptz NOT NULL,
  slot_end     timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'requested'
               CHECK (status IN ('requested','confirmed','declined','cancelled','completed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT viewing_slot_valid CHECK (slot_end > slot_start)
);
CREATE INDEX viewings_listing_idx ON viewings(listing_id, slot_start);
CREATE INDEX viewings_user_idx ON viewings(requested_by, slot_start DESC);
CREATE TRIGGER viewings_updated BEFORE UPDATE ON viewings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
