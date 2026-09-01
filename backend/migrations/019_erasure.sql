-- 019: make account deletion possible, and make it actually erase.
--
-- THE BUG. `documents.owner_id` cascaded from `users`, and
-- `document_access_log.document_id` cascades from `documents` — but that log
-- is append-only at the database level, so the cascade was refused and
-- deleting a user failed outright. Anyone who had uploaded a document and
-- opened it could not be deleted at all, which is to say the PIPEDA erasure
-- path did not work for them.
--
-- It is worse than one blocked cascade. `forbid_mutation` fires on UPDATE as
-- well as DELETE, so `document_access_log.actor_id ON DELETE SET NULL` was
-- refused for the same reason — the redaction it was written to perform could
-- never run. And `audit_log.actor_id` and `ai_calls.actor_id` carry no foreign
-- key at all, so a deleted user's uuid simply stayed in them forever. Three
-- append-only tables, three different ways of not erasing anything.
--
-- Two correct rules are colliding: an account must be erasable, and a trail
-- of who opened what must not be rewritable by the party it is about. The
-- resolution is that neither gives way, because they do not actually conflict
-- — what the trail needs is the FACT of the access, and what erasure removes
-- is the IDENTITY in it.
--
-- THE RESOLUTION, in three parts.
--
-- 1. An append-only table may name columns that are redactable to NULL, and
--    nothing else about it may ever change. `forbid_mutation` takes those
--    column names as trigger arguments and permits exactly one mutation: an
--    UPDATE that sets one or more of them to NULL and leaves every other
--    column identical. Changing a redactable column to a different value is
--    still refused; so is DELETE; so is a table that names none, which is how
--    every existing trigger behaves today.
--
-- 2. A document becomes a tombstone rather than being deleted. On account
--    deletion its owner is set to NULL and the retention job destroys the
--    bytes and blanks the title on its next run, exactly as it does for a
--    document whose retention period expired. What is left is a row with no
--    owner, no title and no bytes for the access log to point at.
--
-- 3. `audit_log` and `ai_calls` keep their deliberate lack of foreign keys —
--    their records must outlive the account, and their actor is not always a
--    user — so a BEFORE DELETE trigger on `users` redacts them instead. The
--    record survives; the uuid in it does not.
--
-- Is retaining the rest lawful? Yes, and it is the reason to keep them. The
-- access log records who opened a document INCLUDING staff and people it was
-- shared with, and a trail the subject's own deletion erases is not evidence
-- of anything — the access it records may be precisely what a complaint is
-- about. PIPEDA 4.5.3 requires that what is kept be no more than the purpose
-- needs, and after this it is not: the title is blanked, the bytes are
-- destroyed, the identity is NULL, and what survives is "some document was
-- opened at 14:02", which identifies nobody. `audit_log` keeps `actor_role`
-- when it loses `actor_id`, so "a staff member approved this listing"
-- survives an employee's erasure with the accountability intact.

-- ── 1. one permitted mutation ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE changed text;
BEGIN
  -- A table that names no redactable column, and every DELETE, behave exactly
  -- as they did before this migration.
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    -- Every column that differs, minus the ones this trigger permits to be
    -- redacted — where a redaction means going TO NULL, not to another value.
    -- A NULL result means the update changed nothing else, so it is one.
    SELECT string_agg(o.key, ', ' ORDER BY o.key)
      INTO changed
      FROM jsonb_each(to_jsonb(OLD)) o
      JOIN jsonb_each(to_jsonb(NEW)) n ON n.key = o.key
     WHERE n.value IS DISTINCT FROM o.value
       AND NOT (o.key = ANY (TG_ARGV) AND n.value = 'null'::jsonb);

    IF changed IS NULL THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'table % is append-only: only % may be redacted to NULL, and % changed',
      TG_TABLE_NAME, array_to_string(TG_ARGV, ', '), changed
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMENT ON FUNCTION forbid_mutation() IS
  'Append-only guard. Trigger arguments name columns that may be redacted to '
  'NULL — an erasure request, performed by ON DELETE SET NULL or by '
  'redact_deleted_actor(). Every other UPDATE and every DELETE is refused '
  'regardless of role privileges. With no arguments the table is immutable.';

-- Each trigger is recreated naming its identity column. Nothing else about
-- these tables becomes mutable: the argument list IS the permission.
DROP TRIGGER document_access_log_no_update ON document_access_log;
CREATE TRIGGER document_access_log_no_update BEFORE UPDATE OR DELETE
  ON document_access_log FOR EACH ROW
  EXECUTE FUNCTION forbid_mutation('actor_id');

DROP TRIGGER audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE
  ON audit_log FOR EACH ROW
  EXECUTE FUNCTION forbid_mutation('actor_id');

DROP TRIGGER ai_calls_immutable ON ai_calls;
CREATE TRIGGER ai_calls_immutable BEFORE UPDATE
  ON ai_calls FOR EACH ROW
  EXECUTE FUNCTION forbid_mutation('actor_id');

-- ── 2. a document outlives its owner as a tombstone ─────────────────────────

ALTER TABLE documents
  ALTER COLUMN owner_id DROP NOT NULL;

ALTER TABLE documents
  DROP CONSTRAINT documents_owner_id_fkey,
  ADD CONSTRAINT documents_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN documents.owner_id IS
  'NULL means the owning account was deleted. The row survives as a tombstone '
  'because document_access_log references it and is append-only; the retention '
  'job destroys the bytes and blanks the title on its next run.';

-- CASCADE here would try to DELETE log rows, which the trigger refuses — so
-- the honest declaration is RESTRICT. A document that has been accessed is
-- tombstoned, never row-deleted, and this says so in the schema instead of
-- surfacing as 'table document_access_log is append-only' from a DELETE
-- nobody expected to reach it.
ALTER TABLE document_access_log
  DROP CONSTRAINT document_access_log_document_id_fkey,
  ADD CONSTRAINT document_access_log_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE RESTRICT;

-- The actor FK was always ON DELETE SET NULL. It could not fire until the
-- trigger above learned to permit exactly that, and the whole redaction is
-- now the database's own doing rather than something application code has to
-- remember on every deletion path.

-- ── 3. the two logs with no foreign keys ────────────────────────────────────

CREATE OR REPLACE FUNCTION redact_deleted_actor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Both are indexed on actor_id, so this is a lookup rather than a scan of a
  -- table that grows per model call.
  UPDATE audit_log SET actor_id = NULL WHERE actor_id = OLD.id;
  UPDATE ai_calls  SET actor_id = NULL WHERE actor_id = OLD.id;
  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION redact_deleted_actor() IS
  'Erases a deleted user from the append-only logs that deliberately carry no '
  'foreign key to users. What was recorded survives; the identity in it does '
  'not. A trigger rather than application code because erasure must not depend '
  'on every future deletion path remembering to call it.';

CREATE TRIGGER users_redact_actor BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION redact_deleted_actor();

-- ── 4. an owner-less document is due for purging now ────────────────────────
-- Its retention period was derived from an account that no longer exists, so
-- it is not a reason to keep anything.
DROP INDEX IF EXISTS documents_purge_idx;
CREATE INDEX documents_purge_idx
  ON documents (retention_until)
  WHERE purged_at IS NULL;
