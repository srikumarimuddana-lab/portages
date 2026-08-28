-- 001: extensions, conventions, shared helpers.
-- Portage runs on stock PostgreSQL. PostGIS/pgvector are OPTIONAL upgrades
-- (see 008); geo search falls back to an indexed bounding-box + haversine
-- filter, which is comfortably fast at single-city scale.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email identity

-- Every mutable table carries updated_at maintained by this trigger.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Append-only guard. Attached to audit_log so a compromised app role cannot
-- rewrite history; the trigger fires regardless of role privileges.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
