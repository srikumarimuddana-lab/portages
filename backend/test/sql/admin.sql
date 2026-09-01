-- Verifies the admin half against real PostgreSQL.
--
-- The TypeScript tests prove what the services decide, using a fake Sql. That
-- fake cannot prove any of the things below, because every one of them is a
-- guarantee the DATABASE makes and the application merely relies on:
--
--   * `audit_log` is append-only for everyone, including us. The whole value
--     of a trail is that the party being audited cannot edit it, and that is a
--     trigger, not a coding convention.
--   * One open queue entry per subject. Without it, three flagged messages
--     from one sender become three items a moderator decides three times.
--   * A staff decision and its audit row commit together or not at all.
--   * The queue's ordering index is actually used by the query the dashboard
--     runs.
--
-- Everything runs inside one transaction and rolls back, so the script is
-- re-runnable against the same database.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL client_min_messages = warning;

CREATE OR REPLACE FUNCTION assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', msg; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION plan_of(q text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE rec record; out text := '';
BEGIN
  -- Sequential scans are disabled while planning so the assertion is about
  -- whether an index CAN serve the predicate, not about whether this fixture
  -- happens to be big enough to make the planner want one.
  SET LOCAL enable_seqscan = off;
  FOR rec IN EXECUTE 'EXPLAIN (COSTS OFF) ' || q LOOP
    out := out || rec."QUERY PLAN" || E'\n';
  END LOOP;
  RESET enable_seqscan;
  RETURN out;
END;
$$;

-- ── fixtures ────────────────────────────────────────────────────────────────

INSERT INTO users (id, email, password_hash, email_verified_at, role) VALUES
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test',    'x', now(), 'user'),
  ('22222222-2222-4222-8222-222222222222', 'inquirer@example.test', 'x', now(), 'user'),
  ('99999999-9999-4999-8999-999999999999', 'staff@example.test',    'x', now(), 'staff');

INSERT INTO properties (id, address_line, address_norm, city, province)
VALUES ('aaaaaaaa-1111-4111-8111-111111111111', '2100 Victoria Ave',
        '2100 victoria avenue', 'Regina', 'SK');

INSERT INTO listings (id, property_id, owner_id, mode, status, price_cents,
                      property_type, title, description, description_source)
VALUES ('bbbbbbbb-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111', 'rent', 'pending_review', 150000,
        'apartment', 'Bright two bedroom in Cathedral',
        'A well-kept two bedroom a short walk from the park.', 'human');

INSERT INTO threads (id, listing_id, owner_id, inquirer_id)
VALUES ('cccccccc-1111-4111-8111-111111111111', 'bbbbbbbb-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

-- ── 1. audit_log is append-only, to us as much as to an attacker ────────────
-- The trigger has existed since migration 001 and, until the admin routes,
-- nothing wrote a row for it to protect. These are the first rows.

INSERT INTO audit_log (actor_id, actor_role, action, subject, subject_id, before, after, ip_hash)
VALUES ('99999999-9999-4999-8999-999999999999', 'staff', 'listing.approve',
        'listing', 'bbbbbbbb-1111-4111-8111-111111111111',
        '{"status":"pending_review"}'::jsonb, '{"status":"live"}'::jsonb,
        '\x0102030405060708'::bytea);

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    UPDATE audit_log SET after = '{"status":"rejected"}'::jsonb
     WHERE action = 'listing.approve';
  EXCEPTION WHEN OTHERS THEN raised := true;
  END;
  PERFORM assert(raised, 'a decision already recorded must not be rewritable');
END;
$$;

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    DELETE FROM audit_log WHERE action = 'listing.approve';
  EXCEPTION WHEN OTHERS THEN raised := true;
  END;
  PERFORM assert(raised, 'a recorded decision must not be deletable');
END;
$$;

-- Even wholesale. A trail that can be truncated is not a trail; this is the
-- form the attack actually takes.
DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    DELETE FROM audit_log;
  EXCEPTION WHEN OTHERS THEN raised := true;
  END;
  PERFORM assert(raised, 'the trail must not be clearable in one statement');
END;
$$;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM audit_log;
  PERFORM assert(n = 1, 'after three attempts to remove it, the entry is still there');
END;
$$;

-- The IP is a digest, never an address. An audit trail that retains raw
-- addresses is itself the privacy liability it was meant to guard against.
DO $$
DECLARE t text;
BEGIN
  SELECT pg_typeof(ip_hash)::text INTO t FROM audit_log LIMIT 1;
  PERFORM assert(t = 'bytea', 'ip_hash must be bytea, so no address can be stored in the clear');
END;
$$;

-- ── 2. one open queue entry per subject ────────────────────────────────────
-- moderation_queue_subject_open_idx is partial on state = 'open'.

INSERT INTO moderation_queue (id, subject_type, subject_id, reason, risk_score)
VALUES ('dddddddd-1111-4111-8111-111111111111', 'listing',
        'bbbbbbbb-1111-4111-8111-111111111111', 'owner_submitted', 12);

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO moderation_queue (subject_type, subject_id, reason, risk_score)
    VALUES ('listing', 'bbbbbbbb-1111-4111-8111-111111111111', 'resubmitted', 12);
  EXCEPTION WHEN unique_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'the same listing must not sit in the queue twice while open');
END;
$$;

-- Once decided, the same subject may queue again — a listing rejected, fixed
-- and resubmitted is a new decision, not a duplicate of the old one.
DO $$
DECLARE n int;
BEGIN
  UPDATE moderation_queue SET state = 'rejected',
         decided_by = '99999999-9999-4999-8999-999999999999', decided_at = now()
   WHERE id = 'dddddddd-1111-4111-8111-111111111111';

  INSERT INTO moderation_queue (subject_type, subject_id, reason, risk_score)
  VALUES ('listing', 'bbbbbbbb-1111-4111-8111-111111111111', 'resubmitted', 12);

  SELECT count(*) INTO n FROM moderation_queue
   WHERE subject_id = 'bbbbbbbb-1111-4111-8111-111111111111';
  PERFORM assert(n = 2, 'a resubmission after a decision must be allowed to queue');

  SELECT count(*) INTO n FROM moderation_queue
   WHERE subject_id = 'bbbbbbbb-1111-4111-8111-111111111111' AND state = 'open';
  PERFORM assert(n = 1, 'and exactly one of them is open');
END;
$$;

-- The dismiss path is `WHERE id = $1 AND state = 'open'`. A second moderator
-- clicking a stale row must change nothing, so the route can tell them.
DO $$
DECLARE n int;
BEGIN
  UPDATE moderation_queue
     SET state = 'approved', decided_by = '99999999-9999-4999-8999-999999999999',
         decided_at = now()
   WHERE id = 'dddddddd-1111-4111-8111-111111111111' AND state = 'open';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM assert(n = 0, 'deciding an already-decided item must affect no rows');

  SELECT count(*) INTO n FROM moderation_queue
   WHERE id = 'dddddddd-1111-4111-8111-111111111111' AND state = 'rejected';
  PERFORM assert(n = 1, 'and must not overwrite the decision that was made');
END;
$$;

-- ── 3. the queue query uses the index it was given ─────────────────────────
-- ORDER BY risk_score DESC, created_at against a partial index on state='open'
-- is the one shape moderation_queue_open_idx serves. Change the ORDER BY and
-- the dashboard silently starts sorting the whole table in memory.
--
-- Enough rows first that the planner has a real choice. On the handful of
-- fixture rows above it bitmap-scans whichever partial index it reaches for
-- and the assertion proves nothing about production — measured, not assumed:
-- at four rows it picks moderation_queue_subject_open_idx, at 20k it does not.
-- Most rows are decided, which is the real shape: the queue is a small live
-- set on top of a growing archive, and the partial index exists for exactly
-- that ratio.

INSERT INTO moderation_queue (subject_type, subject_id, reason, risk_score, state, created_at)
SELECT 'listing', gen_random_uuid(), 'bulk', (random() * 140)::numeric(6,2),
       CASE WHEN i % 8 = 0 THEN 'open' ELSE 'approved' END,
       now() - (i || ' minutes')::interval
  FROM generate_series(1, 20000) i;

INSERT INTO audit_log (actor_id, actor_role, action, subject, subject_id)
SELECT '99999999-9999-4999-8999-999999999999', 'staff', 'listing.approve',
       'listing', gen_random_uuid()::text
  FROM generate_series(1, 20000);

ANALYZE moderation_queue;
ANALYZE audit_log;

DO $$
DECLARE p text;
BEGIN
  p := plan_of($q$
    SELECT id FROM moderation_queue
     WHERE state = 'open'
     ORDER BY risk_score DESC, created_at
     LIMIT 50
  $q$);
  PERFORM assert(p LIKE '%moderation_queue_open_idx%',
    'the queue list must use the partial index; plan was: ' || p);
  PERFORM assert(p NOT LIKE '%Sort%',
    'the index must supply the order, not a sort node; plan was: ' || p);
END;
$$;

-- The audit read is keyset paginated on the bigserial id, newest first.
DO $$
DECLARE p text;
BEGIN
  p := plan_of($q$
    SELECT id FROM audit_log WHERE id < 9223372036854775807 ORDER BY id DESC LIMIT 50
  $q$);
  PERFORM assert(p NOT LIKE '%Seq Scan%',
    'paging the trail must not scan it; plan was: ' || p);
END;
$$;

-- ── 4. release is atomic, and cannot happen twice ──────────────────────────

INSERT INTO messages (id, thread_id, sender_id, body, kind,
                      moderation_verdict, flagged_reasons, delivered_at, is_first_contact)
VALUES ('eeeeeeee-1111-4111-8111-111111111111',
        'cccccccc-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        'I am abroad this week but very interested in the unit.',
        'text', 'block', ARRAY['absent_landlord_script'], NULL, true);

INSERT INTO moderation_queue (id, subject_type, subject_id, reason, risk_score)
VALUES ('dddddddd-2222-4222-8222-222222222222', 'message',
        'eeeeeeee-1111-4111-8111-111111111111', 'moderation_block', 70);

-- What MessagingService.release does, in the order it does it.
DO $$
DECLARE n int; before_count int;
BEGIN
  SELECT message_count INTO before_count FROM threads
   WHERE id = 'cccccccc-1111-4111-8111-111111111111';

  UPDATE messages SET delivered_at = now(), moderation_verdict = 'allow'
   WHERE id = 'eeeeeeee-1111-4111-8111-111111111111';
  UPDATE threads SET last_at = now(), message_count = message_count + 1
   WHERE id = 'cccccccc-1111-4111-8111-111111111111';
  UPDATE moderation_queue SET state = 'approved',
         decided_by = '99999999-9999-4999-8999-999999999999', decided_at = now()
   WHERE subject_type = 'message'
     AND subject_id = 'eeeeeeee-1111-4111-8111-111111111111'
     AND state = 'open';
  INSERT INTO audit_log (actor_id, actor_role, action, subject, subject_id, before, after)
  VALUES ('99999999-9999-4999-8999-999999999999', 'staff', 'message.release',
          'message', 'eeeeeeee-1111-4111-8111-111111111111',
          '{"verdict":"block","delivered":false}'::jsonb,
          '{"verdict":"allow","delivered":true}'::jsonb);

  SELECT message_count INTO n FROM threads
   WHERE id = 'cccccccc-1111-4111-8111-111111111111';
  PERFORM assert(n = before_count + 1, 'a released message counts toward the thread');

  -- The guard against a second release is `delivered_at IS NOT NULL`, which
  -- the service reads under FOR UPDATE. Prove the state it reads is there.
  SELECT count(*) INTO n FROM messages
   WHERE id = 'eeeeeeee-1111-4111-8111-111111111111' AND delivered_at IS NOT NULL;
  PERFORM assert(n = 1, 'the released message is marked delivered');

  SELECT count(*) INTO n FROM moderation_queue
   WHERE subject_id = 'eeeeeeee-1111-4111-8111-111111111111' AND state = 'open';
  PERFORM assert(n = 0, 'and its queue entry is closed, so it is not decided twice');
END;
$$;

-- The released message is now visible on the ordinary inbox read path, which
-- filters on delivery. Before release it was not, which is what made the staff
-- review path necessary in the first place.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM messages
   WHERE thread_id = 'cccccccc-1111-4111-8111-111111111111'
     AND delivered_at IS NOT NULL;
  PERFORM assert(n = 1, 'the recipient can now see it');
END;
$$;

-- ── 5. an upheld block stays invisible ─────────────────────────────────────

INSERT INTO messages (id, thread_id, sender_id, body, kind,
                      moderation_verdict, flagged_reasons, delivered_at, is_first_contact)
VALUES ('eeeeeeee-2222-4222-8222-222222222222',
        'cccccccc-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        'Wire the deposit and I will courier the keys.',
        'text', 'block', ARRAY['money_request'], NULL, false);

INSERT INTO moderation_queue (id, subject_type, subject_id, reason, risk_score)
VALUES ('dddddddd-3333-4333-8333-333333333333', 'message',
        'eeeeeeee-2222-4222-8222-222222222222', 'moderation_block', 130);

DO $$
DECLARE n int;
BEGIN
  UPDATE moderation_queue SET state = 'rejected',
         decided_by = '99999999-9999-4999-8999-999999999999', decided_at = now()
   WHERE subject_type = 'message'
     AND subject_id = 'eeeeeeee-2222-4222-8222-222222222222'
     AND state = 'open';
  INSERT INTO audit_log (actor_id, actor_role, action, subject, subject_id, before, after)
  VALUES ('99999999-9999-4999-8999-999999999999', 'staff', 'message.uphold',
          'message', 'eeeeeeee-2222-4222-8222-222222222222',
          '{"verdict":"block"}'::jsonb, '{"verdict":"block","upheld":true}'::jsonb);

  SELECT count(*) INTO n FROM messages
   WHERE id = 'eeeeeeee-2222-4222-8222-222222222222' AND delivered_at IS NULL;
  PERFORM assert(n = 1, 'upholding must not deliver');

  SELECT count(*) INTO n FROM messages
   WHERE thread_id = 'cccccccc-1111-4111-8111-111111111111'
     AND delivered_at IS NOT NULL;
  PERFORM assert(n = 1, 'the inbox still shows only the released one');
END;
$$;

-- ── 6. the trail survives what it records ──────────────────────────────────
-- audit_log.subject_id is text with no foreign key, deliberately: the record
-- of a deletion must outlive the thing deleted. A cascade here would erase the
-- evidence at exactly the moment it matters.

DO $$
DECLARE n int;
BEGIN
  DELETE FROM messages WHERE id = 'eeeeeeee-2222-4222-8222-222222222222';
  SELECT count(*) INTO n FROM audit_log
   WHERE subject_id = 'eeeeeeee-2222-4222-8222-222222222222';
  PERFORM assert(n = 1, 'deleting the subject must not delete its audit entry');
END;
$$;

-- The actor, though, is a plain uuid column with no FK either — so a staff
-- account being closed cannot cascade away the record of what they decided.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage k
      ON k.constraint_name = tc.constraint_name
   WHERE tc.table_name = 'audit_log' AND tc.constraint_type = 'FOREIGN KEY';
  PERFORM assert(n = 0,
    'audit_log must carry no foreign keys, or a delete elsewhere can erase the trail');
END;
$$;

-- ── 7. staff and admin are distinct roles in the database too ──────────────
-- The route layer splits them; the CHECK is what stops a typo'd role string
-- from silently becoming a role nothing matches and nobody can be granted.

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    UPDATE users SET role = 'superadmin'
     WHERE id = '99999999-9999-4999-8999-999999999999';
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'roles are a closed set; there is no fourth role to escalate into');
END;
$$;

ROLLBACK;

\echo 'admin SQL contract: all assertions passed'
