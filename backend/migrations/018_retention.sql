-- 018: records when a document's bytes were actually destroyed.
--
-- PIPEDA principle 4.5.3 requires personal information to be destroyed once
-- the purpose it was collected for is done. `retention_until` says WHEN that
-- moment arrives; nothing recorded whether the destruction happened, so the
-- question "were these bytes actually deleted, and when?" — the one asked
-- during a complaint — had no answer.
--
-- It also makes the purge job idempotent. Without it the job re-reads and
-- re-deletes the same rows on every run, forever.
--
-- The document ROW cannot simply be deleted: document_access_log references it
-- and carries a forbid_mutation trigger on DELETE, so the cascade would be
-- refused. That is deliberate — an access trail you can erase is not one. So
-- the row survives as a tombstone the log can point at, and the purge blanks
-- the parts of it that are personal.

ALTER TABLE documents
  ADD COLUMN purged_at timestamptz;

COMMENT ON COLUMN documents.purged_at IS
  'When the stored bytes were destroyed. NULL means they are still in object '
  'storage. The row survives because document_access_log references it and is '
  'append-only; the personal fields are blanked at the same time.';

-- The purge job reads exactly this: not yet purged, and either past its
-- retention date or deleted by its owner. Partial, because a purged row is
-- never a candidate again and there will be far more of those than pending
-- ones.
CREATE INDEX documents_purge_idx
  ON documents (retention_until)
  WHERE purged_at IS NULL;
