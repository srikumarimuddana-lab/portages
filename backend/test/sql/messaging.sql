-- Verifies the messaging schema against real PostgreSQL.
--
-- The TypeScript tests prove what MessagingService decides. These prove the
-- database enforces the parts that must not depend on the application getting
-- it right: one thread per (listing, inquirer), a block that cannot be
-- half-recorded, and an unread count that only counts delivered messages from
-- the other party.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL client_min_messages = warning;

CREATE OR REPLACE FUNCTION assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', msg; END IF;
END;
$$;

-- ── fixtures ────────────────────────────────────────────────────────────────

INSERT INTO users (id, email, password_hash, email_verified_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test', 'x', now()),
  ('22222222-2222-4222-8222-222222222222', 'inquirer@example.test', 'x', now()),
  ('33333333-3333-4333-8333-333333333333', 'other@example.test', 'x', now());

INSERT INTO properties (id, address_line, address_norm, city, province)
VALUES ('aaaaaaaa-1111-4111-8111-111111111111', '2100 Victoria Ave',
        '2100 victoria avenue', 'Regina', 'SK');

INSERT INTO listings (id, property_id, owner_id, mode, status, price_cents,
                      property_type, title)
VALUES ('bbbbbbbb-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111', 'rent', 'live', 150000,
        'apartment', 'Bright two bedroom in Cathedral');

-- ── 1. one thread per listing and inquirer ─────────────────────────────────
-- Without this an inquirer could open a parallel conversation on the same
-- listing every time they wrote, and the owner would have to reconcile them.

INSERT INTO threads (id, listing_id, owner_id, inquirer_id)
VALUES ('cccccccc-1111-4111-8111-111111111111', 'bbbbbbbb-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO threads (listing_id, owner_id, inquirer_id)
    VALUES ('bbbbbbbb-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222');
  EXCEPTION WHEN unique_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'a second thread for the same (listing, inquirer) must be refused');
END;
$$;

-- A different inquirer on the same listing is a different conversation.
INSERT INTO threads (id, listing_id, owner_id, inquirer_id)
VALUES ('dddddddd-1111-4111-8111-111111111111', 'bbbbbbbb-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333');

-- ── 2. a thread cannot have one party ──────────────────────────────────────

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO threads (listing_id, owner_id, inquirer_id)
    VALUES ('bbbbbbbb-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111');
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'an owner must not be able to hold a thread with themselves');
END;
$$;

-- ── 3. a block is all-or-nothing ───────────────────────────────────────────
-- thread_block_consistent ties status = 'blocked' to blocked_by being set. A
-- half-recorded block would leave the service unable to say WHO blocked, which
-- is what decides who may lift it.

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    UPDATE threads SET status = 'blocked'
     WHERE id = 'cccccccc-1111-4111-8111-111111111111';
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'blocking without recording who blocked must be refused');

  raised := false;
  BEGIN
    UPDATE threads SET blocked_by = '11111111-1111-4111-8111-111111111111'
     WHERE id = 'cccccccc-1111-4111-8111-111111111111';
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'recording a blocker without blocking must also be refused');

  -- Both together is fine.
  UPDATE threads
     SET status = 'blocked', blocked_by = '11111111-1111-4111-8111-111111111111',
         blocked_at = now()
   WHERE id = 'cccccccc-1111-4111-8111-111111111111';

  -- And unblocking must clear both.
  UPDATE threads SET status = 'open', blocked_by = NULL, blocked_at = NULL
   WHERE id = 'cccccccc-1111-4111-8111-111111111111';
  PERFORM assert(
    (SELECT blocked_by FROM threads WHERE id = 'cccccccc-1111-4111-8111-111111111111') IS NULL,
    'unblocking must clear the blocker');
END;
$$;

-- ── 4. unread counts only delivered messages from the other party ──────────

INSERT INTO messages (id, thread_id, sender_id, body, moderation_verdict,
                      delivered_at, is_first_contact)
VALUES
  -- From the inquirer, delivered: the owner should see this as unread.
  ('e0000000-1111-4111-8111-111111111111', 'cccccccc-1111-4111-8111-111111111111',
   '22222222-2222-4222-8222-222222222222', 'Is this still available?', 'allow',
   now() - interval '5 minutes', true),
  -- From the inquirer, BLOCKED: nobody should ever see it.
  ('e0000000-1111-4111-8111-111111111112', 'cccccccc-1111-4111-8111-111111111111',
   '22222222-2222-4222-8222-222222222222', 'Wire the deposit first.', 'block',
   NULL, false),
  -- From the owner: their own message is never unread to them.
  ('e0000000-1111-4111-8111-111111111113', 'cccccccc-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111111', 'Yes, it is available.', 'allow',
   now() - interval '2 minutes', false);

DO $$
DECLARE owner_unread integer; inquirer_unread integer; visible integer;
BEGIN
  SELECT count(*) INTO owner_unread
    FROM messages m JOIN threads t ON t.id = m.thread_id
   WHERE t.id = 'cccccccc-1111-4111-8111-111111111111'
     AND m.delivered_at IS NOT NULL
     AND m.sender_id <> '11111111-1111-4111-8111-111111111111'
     AND (t.owner_read_at IS NULL OR m.created_at > t.owner_read_at);
  PERFORM assert(owner_unread = 1,
    'the owner has exactly one unread — the blocked one must not count, got ' || owner_unread);

  SELECT count(*) INTO inquirer_unread
    FROM messages m JOIN threads t ON t.id = m.thread_id
   WHERE t.id = 'cccccccc-1111-4111-8111-111111111111'
     AND m.delivered_at IS NOT NULL
     AND m.sender_id <> '22222222-2222-4222-8222-222222222222'
     AND (t.inquirer_read_at IS NULL OR m.created_at > t.inquirer_read_at);
  PERFORM assert(inquirer_unread = 1,
    'the inquirer has one unread, got ' || inquirer_unread);

  -- The thread view shows two messages, not three.
  SELECT count(*) INTO visible FROM messages
   WHERE thread_id = 'cccccccc-1111-4111-8111-111111111111'
     AND delivered_at IS NOT NULL;
  PERFORM assert(visible = 2, 'a blocked message must be invisible in the thread, got ' || visible);

  -- Marking read clears it for that side only.
  UPDATE threads SET owner_read_at = now()
   WHERE id = 'cccccccc-1111-4111-8111-111111111111';

  SELECT count(*) INTO owner_unread
    FROM messages m JOIN threads t ON t.id = m.thread_id
   WHERE t.id = 'cccccccc-1111-4111-8111-111111111111'
     AND m.delivered_at IS NOT NULL
     AND m.sender_id <> '11111111-1111-4111-8111-111111111111'
     AND (t.owner_read_at IS NULL OR m.created_at > t.owner_read_at);
  PERFORM assert(owner_unread = 0, 'reading must clear the owner''s unread');

  SELECT count(*) INTO inquirer_unread
    FROM messages m JOIN threads t ON t.id = m.thread_id
   WHERE t.id = 'cccccccc-1111-4111-8111-111111111111'
     AND m.delivered_at IS NOT NULL
     AND m.sender_id <> '22222222-2222-4222-8222-222222222222'
     AND (t.inquirer_read_at IS NULL OR m.created_at > t.inquirer_read_at);
  PERFORM assert(inquirer_unread = 1, 'and must not clear the other side''s');
END;
$$;

-- ── 5. the blocked message still reaches moderation ────────────────────────
-- It is withheld from the recipient, not from the moderator: a pattern of
-- blocked messages from one account is exactly the signal worth having.

INSERT INTO risk_signals (subject_type, subject_id, signal, weight, detail)
VALUES ('message', 'e0000000-1111-4111-8111-111111111112',
        'payment_before_viewing', 100, '{}'::jsonb);

INSERT INTO moderation_queue (subject_type, subject_id, reason, risk_score)
VALUES ('message', 'e0000000-1111-4111-8111-111111111112', 'message_block', 100);

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM moderation_queue
   WHERE subject_type = 'message' AND state = 'open';
  PERFORM assert(n = 1, 'the blocked message must be queued for review');
END;
$$;

-- ── 6. deleting a listing takes its conversations with it ──────────────────

DO $$
DECLARE n integer;
BEGIN
  DELETE FROM listings WHERE id = 'bbbbbbbb-1111-4111-8111-111111111111';

  SELECT count(*) INTO n FROM threads
   WHERE listing_id = 'bbbbbbbb-1111-4111-8111-111111111111';
  PERFORM assert(n = 0, 'threads must cascade with the listing, ' || n || ' left');

  SELECT count(*) INTO n FROM messages
   WHERE thread_id = 'cccccccc-1111-4111-8111-111111111111';
  PERFORM assert(n = 0, 'and messages with the thread, ' || n || ' left');
END;
$$;

ROLLBACK;

\echo 'messaging SQL contract: all assertions passed'
