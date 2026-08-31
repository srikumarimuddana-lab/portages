-- 011: outbound notifications.
--
-- Three concerns, three tables:
--
--   notification_deliveries  the outbox and the audit trail. Every send
--                            attempt is a row, keyed by an idempotency key,
--                            so a retry cannot send the same SMS twice.
--   suppressions             addresses we must never contact again — hard
--                            bounces, spam complaints, unsubscribes.
--   notification_prefs       per-user, per-kind channel preferences.
--
-- Consent itself is NOT here: it lives in the `consents` table from migration
-- 002, which is the single gate the notify module checks before sending
-- anything non-transactional. CASL penalties reach $10M per violation, so
-- consent is enforced in code and schema rather than documented in a policy.

CREATE TABLE notification_deliveries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The destination, stored so a delivery can be traced without joining to a
  -- user that may since have been deleted.
  destination    text NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('email','sms','whatsapp','push')),
  template       text NOT NULL,
  -- 'transactional' bypasses the consent gate; everything else does not.
  category       text NOT NULL CHECK (category IN ('transactional','saved_search_alert','marketing')),

  -- Caller-supplied and unique. Two attempts to send the same logical
  -- message collapse to one row, which is what makes retries safe.
  idempotency_key text NOT NULL UNIQUE,

  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','sent','failed','suppressed','blocked')),
  attempts       smallint NOT NULL DEFAULT 0,
  provider_message_id text,
  -- Failure reason for operators. Never rendered to an end user.
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  -- Set when the message is scheduled rather than immediate.
  send_after     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER notification_deliveries_updated BEFORE UPDATE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The work queue for the sender job: oldest due first.
CREATE INDEX notification_pending_idx
  ON notification_deliveries(send_after, created_at)
  WHERE status = 'pending';
CREATE INDEX notification_user_idx ON notification_deliveries(user_id, created_at DESC);

-- Addresses that must never be contacted again.
--
-- Sender reputation is not recoverable by apology: continuing to mail a hard
-- bounce or someone who marked you as spam degrades deliverability for every
-- other user. The sender consults this before every send.
CREATE TABLE suppressions (
  destination  text NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('email','sms','whatsapp','push')),
  reason       text NOT NULL CHECK (reason IN
               ('hard_bounce','complaint','unsubscribe','manual','invalid')),
  detail       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (destination, channel)
);

CREATE TABLE notification_prefs (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN
              ('saved_search_alert','message_received','viewing_update','marketing')),
  channel     text NOT NULL CHECK (channel IN ('email','sms','push')),
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, channel)
);
