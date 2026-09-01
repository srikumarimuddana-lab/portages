-- Reverses 014.

DROP INDEX IF EXISTS threads_listing_idx;
DROP INDEX IF EXISTS messages_delivered_idx;
DROP INDEX IF EXISTS threads_inquirer_open_idx;
DROP INDEX IF EXISTS threads_owner_open_idx;

ALTER TABLE messages
  DROP COLUMN IF EXISTS is_first_contact,
  DROP COLUMN IF EXISTS delivered_at,
  DROP COLUMN IF EXISTS flagged_reasons;

ALTER TABLE threads
  DROP CONSTRAINT IF EXISTS thread_block_consistent,
  DROP COLUMN IF EXISTS blocked_at,
  DROP COLUMN IF EXISTS blocked_by,
  DROP COLUMN IF EXISTS message_count,
  DROP COLUMN IF EXISTS inquirer_read_at,
  DROP COLUMN IF EXISTS owner_read_at;
