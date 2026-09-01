-- Reverses 019.
--
-- Restoring `documents.owner_id NOT NULL` means the tombstones cannot stay:
-- they are rows whose owner was deleted, and before this migration such rows
-- could not exist because the deletion that made them was refused. They are
-- deleted here, along with the access-log entries pointing at them, which is
-- the state the schema below can represent.
--
-- Redactions cannot be reversed at all — a NULL actor_id has no value to
-- restore. Rolling back leaves the erasure done, which is the correct
-- direction for it to be irreversible in.

DROP TRIGGER IF EXISTS users_redact_actor ON users;
DROP FUNCTION IF EXISTS redact_deleted_actor();

-- The log has to lose its rows before `documents` can lose the tombstones,
-- and the trigger refuses a DELETE — so it comes off first and goes back on
-- at the end.
DROP TRIGGER document_access_log_no_update ON document_access_log;

DELETE FROM document_access_log
 WHERE document_id IN (SELECT id FROM documents WHERE owner_id IS NULL);

DELETE FROM documents WHERE owner_id IS NULL;

ALTER TABLE document_access_log
  DROP CONSTRAINT document_access_log_document_id_fkey,
  ADD CONSTRAINT document_access_log_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;

ALTER TABLE documents
  DROP CONSTRAINT documents_owner_id_fkey,
  ADD CONSTRAINT documents_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE documents
  ALTER COLUMN owner_id SET NOT NULL;

COMMENT ON COLUMN documents.owner_id IS NULL;

-- Back to the version from 001: no arguments, so no redaction is possible and
-- the trigger arguments below become dead weight rather than a permission.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMENT ON FUNCTION forbid_mutation() IS NULL;

CREATE TRIGGER document_access_log_no_update BEFORE UPDATE OR DELETE
  ON document_access_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE
  ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER ai_calls_immutable ON ai_calls;
CREATE TRIGGER ai_calls_immutable BEFORE UPDATE
  ON ai_calls FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP INDEX IF EXISTS documents_purge_idx;
CREATE INDEX documents_purge_idx
  ON documents (retention_until)
  WHERE purged_at IS NULL;
