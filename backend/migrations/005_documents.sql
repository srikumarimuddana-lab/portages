-- 005: the document locker (feature D1).
-- Portage stores documents the user already has. It does NOT generate, sign,
-- or process them, and it never touches rent or deposit money. That scope
-- keeps us clear of FINTRAC MSB registration, the Retail Payment Activities
-- Act, and the unauthorized-practice-of-law line.

CREATE TABLE documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind         text NOT NULL CHECK (kind IN
               ('agreement','invoice','receipt','inspection','insurance','condo_doc','other')),
  storage_key  text NOT NULL UNIQUE,
  mime         text NOT NULL,
  bytes        bigint NOT NULL CHECK (bytes > 0),
  -- SHA-256 of the ciphertext object, for integrity verification on download.
  content_hash bytea NOT NULL,
  property_id  uuid REFERENCES properties(id) ON DELETE SET NULL,
  thread_id    uuid REFERENCES threads(id) ON DELETE SET NULL,
  -- PIPEDA: retention is a column, not a policy document. A scheduled job
  -- hard-deletes rows past retention_until.
  retention_until timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX documents_owner_idx ON documents(owner_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX documents_retention_idx ON documents(retention_until)
  WHERE deleted_at IS NULL;
CREATE TRIGGER documents_updated BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Explicit, expiring, revocable sharing. Absence of a live row means no access.
CREATE TABLE document_shares (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  shared_with_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX document_shares_unique_idx
  ON document_shares(document_id, shared_with_user_id) WHERE revoked_at IS NULL;

-- Every read of a document is recorded. Answers "who opened my lease?"
CREATE TABLE document_access_log (
  id          bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL CHECK (action IN ('upload','download','share','revoke','delete')),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_access_log_doc_idx ON document_access_log(document_id, at DESC);
CREATE TRIGGER document_access_log_no_update BEFORE UPDATE OR DELETE
  ON document_access_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
