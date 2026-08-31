-- Verifies the flags schema against real PostgreSQL.
--
-- The TypeScript tests prove what FlagService decides against a fake Sql.
-- These prove the parts that must hold even if the application is wrong about
-- them: that a nonsense rollout cannot be stored, that a flip and its audit
-- entry are one unit, that closing a staff account does not erase the record
-- of a switch they threw, and that the upsert the service relies on actually
-- behaves as an upsert.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL client_min_messages = warning;

CREATE OR REPLACE FUNCTION assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', msg; END IF;
END;
$$;

INSERT INTO users (id, email, password_hash, email_verified_at, role) VALUES
  ('99999999-9999-4999-8999-999999999999', 'admin@example.test', 'x', now(), 'admin');

-- ── 1. a nonsense rollout cannot be stored ─────────────────────────────────
-- The service checks these too. The CHECK is what makes the column safe when
-- a future caller forgets to, and 150% is the shape of that mistake.

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO feature_flags (key, rollout_pct) VALUES ('ai.chat_search', 150);
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'a rollout above 100 must be refused');
END;
$$;

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO feature_flags (key, rollout_pct) VALUES ('ai.chat_search', -1);
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'a negative rollout must be refused');
END;
$$;

-- A note long enough to be a pasted stack trace is not a note.
DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO feature_flags (key, note) VALUES ('ai.chat_search', repeat('x', 501));
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'a note over 500 characters must be refused');
END;
$$;

-- ── 2. the upsert the service depends on ───────────────────────────────────
-- `set()` issues ON CONFLICT (key) DO UPDATE with COALESCE, so a partial
-- patch keeps the fields it did not mention. If the primary key were not on
-- `key`, this would silently insert a second row and the newer flip would be
-- invisible to a service reading the older one.

INSERT INTO feature_flags (key, enabled, rollout_pct, note, updated_by)
     VALUES ('channel.email', false, 100, 'SES bounce spike', '99999999-9999-4999-8999-999999999999');

DO $$
DECLARE n int; e boolean; note_now text;
BEGIN
  -- Flip it back on WITHOUT mentioning rollout_pct, exactly as the service
  -- does when the body carries only `enabled`.
  -- $2..$7 in the service's statement: the patch, then the registry defaults
  -- that apply only when there is no previous row to fall back to.
  INSERT INTO feature_flags AS f (key, enabled, rollout_pct, note, updated_by)
       VALUES ('channel.email', COALESCE(true, true), COALESCE(NULL, 100),
               'bounce resolved', '99999999-9999-4999-8999-999999999999')
  ON CONFLICT (key) DO UPDATE
     SET enabled     = COALESCE(true, f.enabled),
         rollout_pct = COALESCE(NULL, f.rollout_pct),
         note        = EXCLUDED.note,
         updated_by  = EXCLUDED.updated_by;

  SELECT count(*) INTO n FROM feature_flags WHERE key = 'channel.email';
  PERFORM assert(n = 1, 'an upsert must not leave two rows for one flag');

  SELECT enabled, note INTO e, note_now FROM feature_flags WHERE key = 'channel.email';
  PERFORM assert(e, 'the switch was released');
  PERFORM assert(note_now = 'bounce resolved', 'and the note says why');

  SELECT rollout_pct INTO n FROM feature_flags WHERE key = 'channel.email';
  PERFORM assert(n = 100, 'a field the patch did not mention must survive it');
END;
$$;

-- The INSERT branch, which is where the bug was: a partial patch against a
-- flag that has never been written must fall back to the registry default,
-- not to NULL. `{"enabled": false}` on a fresh install is the common case and
-- the first thing anyone does with a kill switch.
DO $$
DECLARE pct int; e boolean;
BEGIN
  INSERT INTO feature_flags AS f (key, enabled, rollout_pct, note, updated_by)
       VALUES ('ai.chat_search', COALESCE(false, true), COALESCE(NULL, 100), NULL, NULL)
  ON CONFLICT (key) DO UPDATE
     SET enabled     = COALESCE(false, f.enabled),
         rollout_pct = COALESCE(NULL, f.rollout_pct);

  SELECT enabled, rollout_pct INTO e, pct FROM feature_flags WHERE key = 'ai.chat_search';
  PERFORM assert(NOT e, 'the first flip of an unwritten flag must land');
  PERFORM assert(pct = 100, 'and the field it did not mention takes the registry default');
END;
$$;

-- updated_at is stamped by the trigger, not by the caller. The console shows
-- it as "when was this thrown", so a client that could set it could lie about
-- when a switch went in.
--
-- Note what is NOT asserted here: that the value advanced. set_updated_at
-- uses now(), which is TRANSACTION time, and this whole contract runs in one
-- transaction — so two flips a second apart share a timestamp by design. The
-- guarantee worth testing is that the trigger overrides whatever was
-- supplied, and it is tested by supplying something obviously wrong.
DO $$
DECLARE stamped timestamptz;
BEGIN
  UPDATE feature_flags
     SET enabled = false, updated_at = timestamptz '1999-01-01 00:00:00+00'
   WHERE key = 'channel.email';

  SELECT updated_at INTO stamped FROM feature_flags WHERE key = 'channel.email';
  PERFORM assert(stamped = now(),
    'set_updated_at must overwrite a caller-supplied updated_at with now()');
END;
$$;

-- ── 3. a flip and its record are one unit ──────────────────────────────────
-- FlagService.set() writes both inside one transaction. This asserts the
-- database lets that hold: rolling back must lose BOTH, or the trail would
-- claim a switch was thrown that never was.

DO $$
DECLARE n int;
BEGIN
  BEGIN
    UPDATE feature_flags SET enabled = true WHERE key = 'channel.email';
    INSERT INTO audit_log (actor_id, actor_role, action, subject, subject_id, before, after)
    VALUES ('99999999-9999-4999-8999-999999999999', 'admin', 'flag.set', 'flag', 'channel.email',
            '{"enabled":false}'::jsonb, '{"enabled":true}'::jsonb);
    RAISE EXCEPTION 'rollback probe';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'rollback probe' THEN RAISE; END IF;
  END;

  SELECT count(*) INTO n FROM audit_log
   WHERE action = 'flag.set' AND subject_id = 'channel.email';
  PERFORM assert(n = 0, 'a rolled-back flip must leave no record that it happened');

  SELECT count(*) INTO n FROM feature_flags WHERE key = 'channel.email' AND enabled;
  PERFORM assert(n = 0, 'and must not have changed the flag either');
END;
$$;

-- Committed, both are there.
UPDATE feature_flags SET enabled = true, updated_by = '99999999-9999-4999-8999-999999999999'
 WHERE key = 'channel.email';
INSERT INTO audit_log (actor_id, actor_role, action, subject, subject_id, before, after, ip_hash)
VALUES ('99999999-9999-4999-8999-999999999999', 'admin', 'flag.set', 'flag', 'channel.email',
        '{"enabled":false,"rolloutPct":100}'::jsonb,
        '{"enabled":true,"rolloutPct":100}'::jsonb, '\x0102030405060708'::bytea);

-- The trail is append-only, so a flip cannot be un-recorded afterwards either.
DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    DELETE FROM audit_log WHERE action = 'flag.set';
  EXCEPTION WHEN OTHERS THEN raised := true;
  END;
  PERFORM assert(raised, 'the record of a flip must not be deletable');
END;
$$;

-- ── 4. closing a staff account does not erase the switch ───────────────────
-- updated_by is ON DELETE SET NULL rather than CASCADE. Under CASCADE,
-- deleting the admin who threw a switch would delete the switch — releasing
-- it site-wide, silently, as a side effect of offboarding somebody.

DO $$
DECLARE n int; who uuid;
BEGIN
  DELETE FROM users WHERE id = '99999999-9999-4999-8999-999999999999';

  SELECT count(*) INTO n FROM feature_flags WHERE key = 'channel.email';
  PERFORM assert(n = 1, 'the flag must outlive the account that set it');

  SELECT updated_by INTO who FROM feature_flags WHERE key = 'channel.email';
  PERFORM assert(who IS NULL, 'and the reference is nulled, not dangling');

  SELECT count(*) INTO n FROM audit_log WHERE action = 'flag.set';
  PERFORM assert(n = 1, 'the audit entry survives too — it carries no foreign key');
END;
$$;

-- ── 5. the read the service actually issues ────────────────────────────────
-- One unindexed full read of a dozen rows, on purpose: see 015_flags.sql. This
-- asserts the table stays small enough for that to remain true, so nobody
-- turns it into a per-user table later without noticing the read.

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM feature_flags;
  PERFORM assert(n < 100,
    'feature_flags is read whole on every refresh; it is not a per-subject table');
END;
$$;

ROLLBACK;

\echo 'flags SQL contract: all assertions passed'
