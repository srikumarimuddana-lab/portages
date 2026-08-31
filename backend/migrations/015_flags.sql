-- 015: feature flags and kill switches.
--
-- The lever that stops a runaway AI bill or a mis-sent alert blast at 2am
-- without shipping code. See analysis/11 for why this layer exists at all and
-- why it is deliberately weaker than configuration.
--
-- THE ONE-WAY RULE, restated here because it is a property of the whole
-- design and not of any single file:
--
--     capability live  <=>  configured in env  AND  switch not thrown
--
-- A row here can only SUBTRACT. Turning `channel.sms` on does not make SMS
-- send if SMS_ORIGINATION_IDENTITY is absent from the environment — the
-- channel reports itself unconfigured and the send is refused one step later.
-- That asymmetry is what makes it safe to expose this table to an admin
-- session at all: the worst it can do is cause an outage, and the same lever
-- undoes it in seconds.
--
-- WHAT IS NOT HERE, on purpose:
--
--   * No `default_enabled` column. The value that applies when this table is
--     UNREACHABLE has to live somewhere that is still readable when the
--     database is not — so it lives in code, in modules/flags/registry.ts.
--     A fail-safe default stored in the database is useless in precisely the
--     situation it exists for.
--
--   * No CHECK constraining `key` to a known set. The registry in code is
--     the source of truth for which flags exist; a CHECK here would mean a
--     migration for every new flag, and a deploy is exactly what this table
--     exists to avoid needing. Unknown keys are refused by the service.
--
--   * No history columns. Every flip is written to `audit_log` in the same
--     transaction, and that table is append-only. Two records of the same
--     thing is how they come to disagree.

CREATE TABLE feature_flags (
  key         text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT true,

  -- Percentage rollout, for the feature-flag tier. Kill switches leave this
  -- at 100 and only ever move `enabled`. Held as smallint with a CHECK
  -- because a rollout of 150% or -1 is a typo that should not survive.
  rollout_pct smallint NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),

  -- Why it was thrown. The single most useful field at 3am when someone else
  -- flipped it: "SES bounce spike, ticket 41" answers the question that
  -- otherwise costs a phone call.
  note        text CHECK (note IS NULL OR length(note) <= 500),

  -- ON DELETE SET NULL rather than CASCADE: a staff account being closed must
  -- not delete the record that a switch is currently thrown. Who flipped it
  -- is in audit_log regardless; this is only the convenience copy.
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The service reads the whole table on each refresh rather than one row per
-- check — there are a dozen flags, so a full read is cheaper than a lookup
-- per call site and makes the cache TTL trivially correct. At this size no
-- index beyond the primary key earns its maintenance cost, and saying so
-- here stops someone adding one later on the assumption that it was missed.

CREATE TRIGGER feature_flags_updated BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
