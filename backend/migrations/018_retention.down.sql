DROP INDEX IF EXISTS documents_purge_idx;
ALTER TABLE documents DROP COLUMN IF EXISTS purged_at;
