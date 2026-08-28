-- 006: risk signals, moderation, reports, audit.

CREATE TABLE risk_signals (
  id           bigserial PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('listing','user','message')),
  subject_id   uuid NOT NULL,
  signal       text NOT NULL,
  weight       numeric(5,2) NOT NULL CHECK (weight BETWEEN -100 AND 100),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risk_signals_subject_idx ON risk_signals(subject_type, subject_id, at DESC);

CREATE TABLE moderation_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('listing','user','message')),
  subject_id   uuid NOT NULL,
  reason       text NOT NULL,
  risk_score   numeric(6,2) NOT NULL DEFAULT 0,
  ai_verdict   jsonb,
  state        text NOT NULL DEFAULT 'open'
               CHECK (state IN ('open','approved','rejected','changes_requested')),
  decided_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_queue_open_idx ON moderation_queue(risk_score DESC, created_at)
  WHERE state = 'open';
CREATE UNIQUE INDEX moderation_queue_subject_open_idx
  ON moderation_queue(subject_type, subject_id) WHERE state = 'open';
CREATE TRIGGER moderation_queue_updated BEFORE UPDATE ON moderation_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('listing','user','message','pro')),
  subject_id   uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN
               ('scam','misleading','already_rented','offensive','duplicate','other')),
  detail       text CHECK (detail IS NULL OR length(detail) <= 4000),
  severity     text NOT NULL DEFAULT 'normal' CHECK (severity IN ('low','normal','high','critical')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX reports_open_idx ON reports(severity, created_at DESC) WHERE status = 'open';

-- Append-only. Writes only; the trigger blocks UPDATE and DELETE for everyone.
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor_id   uuid,
  actor_role text,
  action     text NOT NULL,
  subject    text NOT NULL,
  subject_id text,
  before     jsonb,
  after      jsonb,
  ip_hash    bytea,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_subject_idx ON audit_log(subject, subject_id, at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log(actor_id, at DESC);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE
  ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A listing may only be published when an AI-written description has been
-- attested by its owner. Enforced in the database, not just in application code.
CREATE OR REPLACE FUNCTION listing_publishable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'live'
     AND NEW.description_source <> 'human'
     AND NEW.description_attested_at IS NULL THEN
    RAISE EXCEPTION 'AI-authored description requires owner attestation before publish'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER listings_publish_guard BEFORE INSERT OR UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION listing_publishable();
