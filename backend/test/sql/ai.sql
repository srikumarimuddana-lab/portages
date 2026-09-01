-- Verifies the AI call ledger against real PostgreSQL.
--
-- The TypeScript tests prove that MeteredProvider records the right thing.
-- These prove the parts the database owns: that a recorded call cannot be
-- rewritten, that it CAN be pruned (unlike audit_log, and deliberately so),
-- that the outcome and task vocabularies are closed, and that the summary
-- query the ops view runs actually uses an index.

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
  SET LOCAL enable_seqscan = off;
  FOR rec IN EXECUTE 'EXPLAIN (COSTS OFF) ' || q LOOP
    out := out || rec."QUERY PLAN" || E'\n';
  END LOOP;
  RESET enable_seqscan;
  RETURN out;
END;
$$;

INSERT INTO users (id, email, password_hash, email_verified_at)
VALUES ('11111111-1111-4111-8111-111111111111', 'owner@example.test', 'x', now());

-- ── 1. the vocabularies are closed ─────────────────────────────────────────
-- A typo'd task or outcome would silently become a category nothing groups
-- by, so the ops view would under-report spend and nobody would notice.

INSERT INTO ai_calls (task, provider, model, input_tokens, output_tokens, outcome, latency_ms)
VALUES ('chat_search', 'vercel-ai-gateway', 'anthropic/claude-haiku-4-5', 120, 30, 'ok', 410);

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO ai_calls (task, provider, model, outcome)
    VALUES ('chat_serach', 'gw', 'm', 'ok');
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'a misspelled task must be refused, not silently stored');
END;
$$;

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO ai_calls (task, provider, model, outcome)
    VALUES ('chat_search', 'gw', 'm', 'failed');
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'outcome is a closed set — "failed" is not one of them');
END;
$$;

-- Negative token counts are a bug in the caller, not a discount.
DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO ai_calls (task, provider, model, outcome, input_tokens)
    VALUES ('chat_search', 'gw', 'm', 'ok', -5);
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'a negative token count must be refused');
END;
$$;

-- ── 2. immutable, but prunable ─────────────────────────────────────────────
-- The difference from audit_log is the whole point of this section. Both
-- refuse UPDATE; only this one permits DELETE, because it takes a row per
-- model call and a table that can never be pruned grows without bound.

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    UPDATE ai_calls SET input_tokens = 1 WHERE task = 'chat_search';
  EXCEPTION WHEN OTHERS THEN raised := true;
  END;
  PERFORM assert(raised, 'a recorded call must not be rewritable — no relabelling an expensive call as cheap');
END;
$$;

DO $$
DECLARE n int;
BEGIN
  INSERT INTO ai_calls (task, provider, model, outcome, at)
  VALUES ('moderation', 'gw', 'm', 'ok', now() - interval '400 days');

  DELETE FROM ai_calls WHERE at < now() - interval '365 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM assert(n = 1, 'old rows must be prunable — this is not audit_log');

  SELECT count(*) INTO n FROM ai_calls;
  PERFORM assert(n = 1, 'and the recent row is untouched');
END;
$$;

-- Contrast, asserted rather than described: audit_log refuses both.
DO $$
DECLARE raised boolean := false;
BEGIN
  INSERT INTO audit_log (actor_id, actor_role, action, subject, subject_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'admin', 'flag.set', 'flag', 'ai.chat_search');
  BEGIN
    DELETE FROM audit_log WHERE action = 'flag.set';
  EXCEPTION WHEN OTHERS THEN raised := true;
  END;
  PERFORM assert(raised, 'audit_log stays undeletable; only the AI ledger is prunable');
END;
$$;

-- ── 3. the record outlives the account, the identity does not ──────────────
--
-- No foreign keys, matching audit_log: a cascade would erase what was spent
-- on someone's behalf at exactly the moment it matters. But "the row must
-- survive" is not "the uuid must survive", and until 019 nothing distinguished
-- them — a deleted user's id simply stayed here, because with no FK there was
-- nothing to null it out. `redact_deleted_actor` does it now.
--
-- What is left answers "what did this cost and what was it for", which is the
-- entire reason the table exists, without answering "who".

DO $$
DECLARE n int; actor uuid; subj text;
BEGIN
  INSERT INTO ai_calls (task, provider, model, outcome, actor_id, subject_type, subject_id)
  VALUES ('listing_builder', 'gw', 'm', 'ok',
          '11111111-1111-4111-8111-111111111111', 'listing', 'some-listing-id');

  DELETE FROM users WHERE id = '11111111-1111-4111-8111-111111111111';

  SELECT count(*) INTO n FROM ai_calls WHERE task = 'listing_builder';
  PERFORM assert(n = 1, 'the spend record must outlive the account');

  SELECT actor_id INTO actor FROM ai_calls WHERE task = 'listing_builder';
  PERFORM assert(actor IS NULL, 'but must not still name the deleted account');

  SELECT subject_id INTO subj FROM ai_calls WHERE task = 'listing_builder';
  PERFORM assert(subj = 'some-listing-id',
    'while everything the record exists to answer survives intact');

  SELECT count(*) INTO n
    FROM information_schema.table_constraints
   WHERE table_name = 'ai_calls' AND constraint_type = 'FOREIGN KEY';
  PERFORM assert(n = 0,
    'and ai_calls must still carry no foreign keys — the redaction is a '
    || 'trigger on users precisely so this table needs none');
END;
$$;

-- ── 4. no content column exists to put a message body in ───────────────────
-- The hard line from migrations/016_ai.sql, asserted so that adding one is a
-- failing test rather than a code review someone skims.

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO bad
    FROM information_schema.columns
   WHERE table_name = 'ai_calls'
     AND column_name IN ('prompt', 'completion', 'body', 'system', 'messages',
                         'request', 'response', 'content', 'text');
  PERFORM assert(bad IS NULL,
    'ai_calls must hold no content — found: ' || coalesce(bad, ''));
END;
$$;

-- ── 5. the ops summary uses an index ───────────────────────────────────────
-- Enough rows that the planner has a real choice, as in the other contracts:
-- at a handful of rows every plan looks the same and the assertion proves
-- nothing about production.

INSERT INTO ai_calls (task, provider, model, input_tokens, output_tokens, outcome, latency_ms, at)
SELECT (ARRAY['chat_search', 'moderation', 'listing_builder'])[1 + (i % 3)],
       'vercel-ai-gateway', 'anthropic/claude-haiku-4-5',
       (random() * 2000)::int, (random() * 400)::int,
       CASE WHEN i % 50 = 0 THEN 'refused' WHEN i % 97 = 0 THEN 'timeout' ELSE 'ok' END,
       (random() * 3000)::int,
       now() - make_interval(mins => i)
  FROM generate_series(1, 40000) i;

ANALYZE ai_calls;

DO $$
DECLARE p text;
BEGIN
  p := plan_of($q$
    SELECT task, count(*) FROM ai_calls
     WHERE at > now() - interval '24 hours'
     GROUP BY task
  $q$);
  PERFORM assert(p NOT LIKE '%Seq Scan%',
    'the ops summary must not scan the whole ledger; plan was: ' || p);
END;
$$;

-- "What went wrong" is a small slice of a large table, and the partial index
-- exists so finding it does not mean reading the successful calls.
DO $$
DECLARE p text; n int;
BEGIN
  p := plan_of($q$
    SELECT id FROM ai_calls
     WHERE outcome <> 'ok' AND task = 'chat_search'
     ORDER BY at DESC LIMIT 50
  $q$);
  PERFORM assert(p LIKE '%ai_calls_failed_idx%',
    'the failure view must use the partial index; plan was: ' || p);

  SELECT count(*) INTO n FROM ai_calls WHERE outcome <> 'ok';
  PERFORM assert(n > 0 AND n < 2000,
    'the partial index is only worth it while failures are a small slice');
END;
$$;

ROLLBACK;

\echo 'ai SQL contract: all assertions passed'
