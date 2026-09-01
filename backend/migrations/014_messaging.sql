-- 014: what the inbox needs on top of threads and messages.
--
-- Migration 004 built the right shape — one thread per (listing, inquirer),
-- messages carrying a moderation verdict that gates delivery. Three things
-- were missing, and each of them is the difference between a table and an
-- inbox.

-- ── read state ──────────────────────────────────────────────────────────────
-- Two columns rather than a participants table: a thread has exactly two
-- parties by construction (see thread_parties_differ in 004), so a join table
-- would model a generality that does not exist and cost a join on every
-- inbox load.

ALTER TABLE threads
  ADD COLUMN owner_read_at    timestamptz,
  ADD COLUMN inquirer_read_at timestamptz,
  -- Denormalized so the inbox list does not count messages per thread. The
  -- service maintains it inside the same transaction as the insert.
  ADD COLUMN message_count    integer NOT NULL DEFAULT 0,
  -- Who closed the conversation, and when. `status = 'blocked'` alone says
  -- a thread is blocked but not by whom — which is exactly what is needed to
  -- decide whether the OTHER party may reopen it.
  ADD COLUMN blocked_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN blocked_at       timestamptz,
  ADD CONSTRAINT thread_block_consistent
    CHECK ((status = 'blocked') = (blocked_by IS NOT NULL));

-- The inbox query: a party's threads, newest activity first. Partial on open
-- threads because that is the default view and archived threads are rare.
CREATE INDEX threads_owner_open_idx ON threads(owner_id, last_at DESC)
  WHERE status = 'open';
CREATE INDEX threads_inquirer_open_idx ON threads(inquirer_id, last_at DESC)
  WHERE status = 'open';

-- ── message moderation ──────────────────────────────────────────────────────

ALTER TABLE messages
  -- Which signals fired, so a moderator sees WHY rather than just a verdict,
  -- and so a false positive can be traced to the rule that caused it.
  ADD COLUMN flagged_reasons text[] NOT NULL DEFAULT '{}',
  -- Set when a message is withheld. The sender is told it was not delivered;
  -- the recipient never sees it at all.
  ADD COLUMN delivered_at timestamptz;

-- Delivery is what the thread view reads, so it is what the index covers.
CREATE INDEX messages_delivered_idx ON messages(thread_id, created_at)
  WHERE delivered_at IS NOT NULL;

-- ── enquiry provenance ──────────────────────────────────────────────────────
-- A first message is a different thing from a reply: it arrives from a
-- stranger, on a public listing, and is where nearly all abuse enters. The
-- column lets moderation and analytics tell the two apart without inferring
-- it from ordering.

ALTER TABLE messages
  ADD COLUMN is_first_contact boolean NOT NULL DEFAULT false;

-- A per-listing enquiry counter, for the owner's dashboard and for spotting
-- a listing that draws unusual volume.
CREATE INDEX threads_listing_idx ON threads(listing_id, created_at DESC);
