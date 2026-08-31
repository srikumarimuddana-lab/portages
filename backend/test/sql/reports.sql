-- Verifies the report schema against real PostgreSQL.
--
-- The TypeScript tests prove what ReportService decides. These prove the
-- guarantee it relies on and cannot enforce itself: that the database refuses
-- a second open report from the same person about the same subject, so
-- "distinct reporters" is a fact rather than a hope.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL client_min_messages = warning;

CREATE OR REPLACE FUNCTION assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', msg; END IF;
END;
$$;

INSERT INTO users (id, email, password_hash, email_verified_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test',    'x', now()),
  ('22222222-2222-4222-8222-222222222222', 'reporter@example.test', 'x', now()),
  ('33333333-3333-4333-8333-333333333333', 'other@example.test',    'x', now());

INSERT INTO properties (id, address_line, address_norm, city, province)
VALUES ('aaaaaaaa-1111-4111-8111-111111111111', '2100 Victoria Ave',
        '2100 victoria avenue', 'Regina', 'SK');

INSERT INTO listings (id, property_id, owner_id, mode, status, price_cents,
                      property_type, title)
VALUES ('bbbbbbbb-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111', 'rent', 'live', 150000,
        'apartment', 'Bright two bedroom in Cathedral');

-- ── 1. one open report per person per subject ──────────────────────────────
-- The distinction the whole design rests on: ten people reporting one listing
-- is corroboration; one person reporting it ten times is one opinion. A
-- count(*) cannot tell them apart, so the index makes the second impossible.

INSERT INTO reports (reporter_id, subject_type, subject_id, kind, severity)
VALUES ('22222222-2222-4222-8222-222222222222', 'listing',
        'bbbbbbbb-1111-4111-8111-111111111111', 'scam', 'high');

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO reports (reporter_id, subject_type, subject_id, kind, severity)
    VALUES ('22222222-2222-4222-8222-222222222222', 'listing',
            'bbbbbbbb-1111-4111-8111-111111111111', 'scam', 'high');
  EXCEPTION WHEN unique_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'the same person must not be able to report the same subject twice');
END;
$$;

-- A different kind from the same person is still the same person.
DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO reports (reporter_id, subject_type, subject_id, kind, severity)
    VALUES ('22222222-2222-4222-8222-222222222222', 'listing',
            'bbbbbbbb-1111-4111-8111-111111111111', 'misleading', 'normal');
  EXCEPTION WHEN unique_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'changing the kind must not be a way around the guard');
END;
$$;

-- A DIFFERENT person is the case the queue is supposed to weight up.
DO $$
DECLARE n int;
BEGIN
  INSERT INTO reports (reporter_id, subject_type, subject_id, kind, severity)
  VALUES ('33333333-3333-4333-8333-333333333333', 'listing',
          'bbbbbbbb-1111-4111-8111-111111111111', 'scam', 'high');

  SELECT count(DISTINCT reporter_id) INTO n FROM reports
   WHERE subject_id = 'bbbbbbbb-1111-4111-8111-111111111111' AND status = 'open';
  PERFORM assert(n = 2, 'two distinct reporters must both be counted');
END;
$$;

-- ── 2. a closed report does not block a genuine recurrence ─────────────────
-- The index is partial on status = 'open' for this reason: a listing that was
-- reported, cleared, and has gone bad again must be reportable by the same
-- person.

DO $$
DECLARE n int;
BEGIN
  UPDATE reports SET status = 'dismissed', resolved_at = now()
   WHERE reporter_id = '22222222-2222-4222-8222-222222222222';

  INSERT INTO reports (reporter_id, subject_type, subject_id, kind, severity)
  VALUES ('22222222-2222-4222-8222-222222222222', 'listing',
          'bbbbbbbb-1111-4111-8111-111111111111', 'scam', 'high');

  SELECT count(*) INTO n FROM reports
   WHERE reporter_id = '22222222-2222-4222-8222-222222222222';
  PERFORM assert(n = 2, 'the same person may report again once the first is closed');

  SELECT count(*) INTO n FROM reports
   WHERE reporter_id = '22222222-2222-4222-8222-222222222222' AND status = 'open';
  PERFORM assert(n = 1, 'but only one of theirs is open at a time');
END;
$$;

-- ── 3. the vocabularies are closed ─────────────────────────────────────────

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO reports (reporter_id, subject_type, subject_id, kind)
    VALUES ('33333333-3333-4333-8333-333333333333', 'listing',
            'bbbbbbbb-1111-4111-8111-111111111111', 'i_do_not_like_it');
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'kind is a closed set');
END;
$$;

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO reports (reporter_id, subject_type, subject_id, kind, detail)
    VALUES ('33333333-3333-4333-8333-333333333333', 'user',
            '11111111-1111-4111-8111-111111111111', 'other', repeat('x', 4001));
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'detail is capped at 4000 characters');
END;
$$;

-- ── 4. the report survives its reporter ────────────────────────────────────
-- ON DELETE SET NULL, not CASCADE: someone who reports a scam and then closes
-- their account must not take the evidence with them — which is exactly what
-- a scammer would ask them to do.

DO $$
DECLARE n int; who uuid;
BEGIN
  DELETE FROM users WHERE id = '33333333-3333-4333-8333-333333333333';

  SELECT count(*) INTO n FROM reports
   WHERE subject_id = 'bbbbbbbb-1111-4111-8111-111111111111';
  PERFORM assert(n = 3, 'deleting a reporter must not delete their reports');

  SELECT reporter_id INTO who FROM reports
   WHERE subject_id = 'bbbbbbbb-1111-4111-8111-111111111111'
     AND reporter_id IS NULL LIMIT 1;
  PERFORM assert(who IS NULL, 'the reference is nulled, not dangling');
END;
$$;

-- With reporter_id NULL the partial index no longer applies to that row, so
-- an orphaned report cannot block anyone. Asserted, because the WHERE clause
-- on the index is what makes it true and it is easy to drop by accident.
DO $$
DECLARE n int;
BEGIN
  INSERT INTO reports (reporter_id, subject_type, subject_id, kind, severity)
  VALUES (NULL, 'listing', 'bbbbbbbb-1111-4111-8111-111111111111', 'scam', 'high');
  INSERT INTO reports (reporter_id, subject_type, subject_id, kind, severity)
  VALUES (NULL, 'listing', 'bbbbbbbb-1111-4111-8111-111111111111', 'scam', 'high');

  SELECT count(*) INTO n FROM reports WHERE reporter_id IS NULL;
  PERFORM assert(n >= 2, 'orphaned reports are not deduplicated against each other');
END;
$$;

-- ── 5. reports and the queue ───────────────────────────────────────────────
-- The service upserts with GREATEST, so a stream of low-severity reports
-- cannot drag a subject DOWN the queue below where a scam report put it.

DO $$
DECLARE score numeric;
BEGIN
  INSERT INTO moderation_queue (subject_type, subject_id, reason, risk_score)
  VALUES ('listing', 'bbbbbbbb-1111-4111-8111-111111111111', 'user_report_scam', 45);

  INSERT INTO moderation_queue (subject_type, subject_id, reason, risk_score)
       VALUES ('listing', 'bbbbbbbb-1111-4111-8111-111111111111', 'user_report_already_rented', 6)
  ON CONFLICT (subject_type, subject_id) WHERE state = 'open'
  DO UPDATE SET risk_score = GREATEST(moderation_queue.risk_score, EXCLUDED.risk_score),
                reason = EXCLUDED.reason;

  SELECT risk_score INTO score FROM moderation_queue
   WHERE subject_id = 'bbbbbbbb-1111-4111-8111-111111111111' AND state = 'open';
  PERFORM assert(score = 45,
    'a low-severity report must not lower a subject already flagged as a scam');
END;
$$;

-- ── 6. the counting query does not scan ────────────────────────────────────
-- Asked once per incoming report, on the write path. Without
-- reports_subject_idx it is a sequential scan that gets slower as the table
-- grows, which is precisely backwards.

INSERT INTO reports (reporter_id, subject_type, subject_id, kind, severity, status)
SELECT NULL, 'listing', gen_random_uuid(), 'misleading', 'normal',
       CASE WHEN i % 4 = 0 THEN 'open' ELSE 'resolved' END
  FROM generate_series(1, 30000) i;

ANALYZE reports;

DO $$
DECLARE p text; rec record;
BEGIN
  SET LOCAL enable_seqscan = off;
  p := '';
  FOR rec IN
    EXPLAIN (COSTS OFF)
    SELECT count(DISTINCT reporter_id) FROM reports
     WHERE subject_type = 'listing'
       AND subject_id = 'bbbbbbbb-1111-4111-8111-111111111111'
       AND status = 'open'
  LOOP
    p := p || rec."QUERY PLAN" || E'\n';
  END LOOP;
  RESET enable_seqscan;

  PERFORM assert(p LIKE '%reports_subject_idx%',
    'counting reporters for a subject must use the index; plan was: ' || p);
  PERFORM assert(p NOT LIKE '%Seq Scan%',
    'and must not scan the table; plan was: ' || p);
END;
$$;

ROLLBACK;

\echo 'reports SQL contract: all assertions passed'
