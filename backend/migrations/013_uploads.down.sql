-- Reverses 013.

DROP INDEX IF EXISTS listing_media_stored_idx;

ALTER TABLE documents DROP COLUMN IF EXISTS status;

ALTER TABLE listing_media
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS height,
  DROP COLUMN IF EXISTS width,
  DROP COLUMN IF EXISTS orientation,
  DROP COLUMN IF EXISTS blurhash;

DROP TABLE IF EXISTS uploads;
