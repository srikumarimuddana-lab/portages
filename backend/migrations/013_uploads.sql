-- 013: the upload lifecycle.
--
-- Until now `signStorageUrl` minted tickets that nothing redeemed, and
-- `verifyStorageUrl` had no caller — so a listing photo or locker document was
-- a row with a storage_key pointing at an object that did not exist. This adds
-- the state that makes an upload a thing with a beginning and an end.
--
-- The states matter because an upload can fail in the middle. A row that is
-- `pending` forever is an abandoned upload to sweep; a row that is `stored` is
-- a file that is really there and has really been checked.

CREATE TABLE uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What this upload belongs to. Deliberately not a foreign key: the same
  -- lifecycle serves listing photos and locker documents, and a polymorphic
  -- FK would mean either two nullable columns or a constraint that lies.
  subject_type  text NOT NULL CHECK (subject_type IN ('listing_media','document')),
  subject_id    uuid NOT NULL,
  storage_key   text NOT NULL UNIQUE,

  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','stored','rejected','expired')),
  -- What the client SAID at ticket time. Kept apart from the verified values
  -- below, because one is a claim and the other is an observation.
  declared_mime  text NOT NULL,
  declared_bytes bigint NOT NULL CHECK (declared_bytes > 0),

  -- What the object actually turned out to be, read back from storage.
  verified_mime  text,
  verified_bytes bigint,
  content_hash   bytea,

  -- Metadata handling, recorded for the audit trail rather than for display.
  -- `had_gps` is worth keeping: it says the uploader's device recorded where
  -- the photo was taken, which is exactly what was stripped.
  metadata_stripped text[] NOT NULL DEFAULT '{}',
  had_gps        boolean NOT NULL DEFAULT false,
  exif_orientation smallint CHECK (exif_orientation BETWEEN 1 AND 8),

  reject_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  completed_at  timestamptz
);

CREATE INDEX uploads_subject_idx ON uploads(subject_type, subject_id);
CREATE INDEX uploads_owner_idx ON uploads(owner_id, created_at DESC);
-- Drives the sweeper: tickets that were issued and never completed.
CREATE INDEX uploads_pending_idx ON uploads(expires_at) WHERE status = 'pending';

-- Listing photos gain the fields the image pipeline produces.
ALTER TABLE listing_media
  -- ~30 bytes that render as a blurred approximation with no network request,
  -- so a search card never shows a grey rectangle. Supplied by the browser,
  -- which already holds the decoded image; it is cosmetic, so a dishonest one
  -- only spoils the uploader's own card.
  ADD COLUMN blurhash text CHECK (blurhash IS NULL OR length(blurhash) <= 64),
  -- EXIF orientation is stripped with the rest of the metadata, but rotating
  -- the pixels needs a decoder. Recording it lets the client apply the
  -- rotation as a transform instead.
  ADD COLUMN orientation smallint CHECK (orientation BETWEEN 1 AND 8),
  ADD COLUMN width  integer CHECK (width  IS NULL OR width  BETWEEN 1 AND 20000),
  ADD COLUMN height integer CHECK (height IS NULL OR height BETWEEN 1 AND 20000),
  -- Until an upload completes, a photo row exists but its bytes may not.
  -- Search and listing pages show only `stored` media.
  ADD COLUMN status text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','stored','rejected'));

-- The cover-photo query reads only stored media, so the index does too.
CREATE INDEX listing_media_stored_idx ON listing_media(listing_id, position)
  WHERE status = 'stored';

-- Documents get the same distinction, for the same reason.
ALTER TABLE documents
  ADD COLUMN status text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','stored','rejected'));
