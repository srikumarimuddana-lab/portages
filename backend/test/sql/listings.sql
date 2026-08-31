-- Verifies the database behaviour that ListingService depends on.
--
-- The TypeScript tests use a fake Sql, so they prove the service's decisions
-- but say nothing about whether the statements it sends actually behave the
-- way it assumes. Everything checked here is a claim the service makes about
-- PostgreSQL that would otherwise be untested until production:
--
--   * a partial unique index really does refuse the second live listing
--   * ON CONFLICT can target a partial unique index by repeating its predicate
--   * the publish-guard trigger fires on the path the service takes
--   * the property upsert returns the existing row rather than a new one
--
-- Run with ON_ERROR_STOP=1 against a database with every migration applied.
-- Each check raises an exception on failure, so a non-zero exit is a real
-- failure and a clean run means every assertion held.

\set ON_ERROR_STOP on

BEGIN;

-- Isolation: everything here runs inside one transaction and is rolled back.
SET LOCAL client_min_messages = warning;

CREATE OR REPLACE FUNCTION assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', msg; END IF;
END;
$$;

-- ── fixtures ────────────────────────────────────────────────────────────────

INSERT INTO users (id, email, password_hash, email_verified_at)
VALUES ('11111111-1111-4111-8111-111111111111', 'owner-a@example.test', 'x', now()),
       ('22222222-2222-4222-8222-222222222222', 'owner-b@example.test', 'x', now());

-- ── 1. property upsert is idempotent on the normalized key ──────────────────

DO $$
DECLARE first_id uuid; second_id uuid;
BEGIN
  INSERT INTO properties (address_line, unit, address_norm, city, province, postal_code)
  VALUES ('123 Victoria Ave', NULL, '123 victoria avenue', 'Regina', 'SK', 'S4P 0N7')
  ON CONFLICT (address_norm, city, province) DO UPDATE
    SET postal_code = COALESCE(properties.postal_code, EXCLUDED.postal_code),
        updated_at = now()
  RETURNING id INTO first_id;

  -- Same normalized address, written differently, no postal code this time.
  INSERT INTO properties (address_line, unit, address_norm, city, province, postal_code)
  VALUES ('123 Victoria Avenue', NULL, '123 victoria avenue', 'Regina', 'SK', NULL)
  ON CONFLICT (address_norm, city, province) DO UPDATE
    SET postal_code = COALESCE(properties.postal_code, EXCLUDED.postal_code),
        updated_at = now()
  RETURNING id INTO second_id;

  PERFORM assert(first_id = second_id, 'upsert must return the existing property row');
  PERFORM assert(
    (SELECT postal_code FROM properties WHERE id = first_id) = 'S4P 0N7',
    'COALESCE must keep the existing postal code rather than nulling it');
  PERFORM assert(
    (SELECT address_line FROM properties WHERE id = first_id) = '123 Victoria Ave',
    'a second lister must not overwrite the display address');
END;
$$;

-- ── 2. a unit makes a distinct property ────────────────────────────────────

DO $$
DECLARE bare_id uuid; unit_id uuid;
BEGIN
  SELECT id INTO bare_id FROM properties WHERE address_norm = '123 victoria avenue';

  INSERT INTO properties (address_line, unit, address_norm, city, province)
  VALUES ('123 Victoria Ave', '4', '123 victoria avenue unit 4', 'Regina', 'SK')
  RETURNING id INTO unit_id;

  PERFORM assert(bare_id <> unit_id,
    'unit 4 must be a different property from the building address');
END;
$$;

-- ── 3. one live listing per property ───────────────────────────────────────

DO $$
DECLARE prop_id uuid; raised boolean := false;
BEGIN
  SELECT id INTO prop_id FROM properties WHERE address_norm = '123 victoria avenue';

  INSERT INTO listings (id, property_id, owner_id, mode, status, price_cents,
                        property_type, title)
  VALUES ('aaaaaaaa-0000-4000-8000-000000000001', prop_id,
          '11111111-1111-4111-8111-111111111111', 'rent', 'live', 150000,
          'apartment', 'Bright one bedroom on Victoria');

  -- A second owner reaching the same property row is a legitimate state;
  -- publishing a second listing for it is not.
  BEGIN
    INSERT INTO listings (id, property_id, owner_id, mode, status, price_cents,
                          property_type, title)
    VALUES ('aaaaaaaa-0000-4000-8000-000000000002', prop_id,
            '22222222-2222-4222-8222-222222222222', 'rent', 'live', 160000,
            'apartment', 'Same unit, different poster');
  EXCEPTION WHEN unique_violation THEN
    raised := true;
    PERFORM assert(
      -- The service matches on this constraint name to turn 23505 into a 409.
      -- If it ever changes, that mapping silently stops working.
      SQLERRM LIKE '%listings_one_live_per_property%',
      'unique violation must name listings_one_live_per_property, got: ' || SQLERRM);
  END;

  PERFORM assert(raised, 'a second live listing for one property must be refused');
END;
$$;

-- A draft for the same property is fine — the index is partial on status.
INSERT INTO listings (id, property_id, owner_id, mode, status, price_cents,
                      property_type, title)
SELECT 'aaaaaaaa-0000-4000-8000-000000000003', id,
       '22222222-2222-4222-8222-222222222222', 'rent', 'draft', 160000,
       'apartment', 'Draft for the same address'
  FROM properties WHERE address_norm = '123 victoria avenue';

-- ── 4. the AI-description publish guard ────────────────────────────────────

DO $$
DECLARE prop_id uuid; raised boolean := false;
BEGIN
  INSERT INTO properties (address_line, address_norm, city, province)
  VALUES ('88 Albert St', '88 albert street', 'Regina', 'SK')
  RETURNING id INTO prop_id;

  INSERT INTO listings (id, property_id, owner_id, mode, status, price_cents,
                        property_type, title, description, description_source)
  VALUES ('bbbbbbbb-0000-4000-8000-000000000001', prop_id,
          '11111111-1111-4111-8111-111111111111', 'rent', 'draft', 145000,
          'apartment', 'Albert Street suite', 'Written by a model.', 'ai_generated');

  BEGIN
    UPDATE listings SET status = 'live'
     WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';
  EXCEPTION WHEN check_violation THEN
    raised := true;
  END;
  PERFORM assert(raised, 'unattested AI copy must not reach live');

  -- With attestation it goes through.
  UPDATE listings SET description_attested_at = now()
   WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';
  UPDATE listings SET status = 'live'
   WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';
  PERFORM assert(
    (SELECT status FROM listings WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001') = 'live',
    'attested AI copy must be publishable');
END;
$$;

-- ── 5. moderation queue upsert against the PARTIAL unique index ────────────
-- The service re-enqueues on every submit. This only works if ON CONFLICT can
-- target moderation_queue_subject_open_idx, which requires repeating the
-- index predicate in the conflict target.

DO $$
DECLARE n integer;
BEGIN
  INSERT INTO moderation_queue (subject_type, subject_id, reason, risk_score)
  VALUES ('listing', 'aaaaaaaa-0000-4000-8000-000000000001', 'owner_submitted', 12)
  ON CONFLICT (subject_type, subject_id) WHERE state = 'open'
  DO UPDATE SET risk_score = EXCLUDED.risk_score, reason = EXCLUDED.reason;

  INSERT INTO moderation_queue (subject_type, subject_id, reason, risk_score)
  VALUES ('listing', 'aaaaaaaa-0000-4000-8000-000000000001', 'edited_after_approval', 37)
  ON CONFLICT (subject_type, subject_id) WHERE state = 'open'
  DO UPDATE SET risk_score = EXCLUDED.risk_score, reason = EXCLUDED.reason;

  SELECT count(*) INTO n FROM moderation_queue
   WHERE subject_id = 'aaaaaaaa-0000-4000-8000-000000000001' AND state = 'open';
  PERFORM assert(n = 1, 'resubmitting must update the open queue entry, not add one');
  PERFORM assert(
    (SELECT risk_score FROM moderation_queue
      WHERE subject_id = 'aaaaaaaa-0000-4000-8000-000000000001' AND state = 'open') = 37,
    'the queue entry must carry the newest risk score');

  -- Once decided, the partial index no longer covers it, so a later submit
  -- opens a fresh entry instead of reviving the decided one.
  UPDATE moderation_queue SET state = 'approved', decided_at = now()
   WHERE subject_id = 'aaaaaaaa-0000-4000-8000-000000000001' AND state = 'open';

  INSERT INTO moderation_queue (subject_type, subject_id, reason, risk_score)
  VALUES ('listing', 'aaaaaaaa-0000-4000-8000-000000000001', 'resubmitted', 5)
  ON CONFLICT (subject_type, subject_id) WHERE state = 'open'
  DO UPDATE SET risk_score = EXCLUDED.risk_score, reason = EXCLUDED.reason;

  SELECT count(*) INTO n FROM moderation_queue
   WHERE subject_id = 'aaaaaaaa-0000-4000-8000-000000000001';
  PERFORM assert(n = 2, 'a decided entry must not be reopened by a new submit');
END;
$$;

-- ── 6. risk signals accept the shape the service writes ────────────────────

INSERT INTO risk_signals (subject_type, subject_id, signal, weight, detail)
VALUES ('listing', 'aaaaaaaa-0000-4000-8000-000000000001',
        'off_platform_payment_language', 30, '{"terms":["wire transfer"]}'::jsonb);

DO $$
BEGIN
  PERFORM assert(
    (SELECT sum(weight) FROM risk_signals
      WHERE subject_id = 'aaaaaaaa-0000-4000-8000-000000000001') = 30,
    'risk signal must be readable back for scoring');
END;
$$;

-- ── 7. the batched photo fetch ─────────────────────────────────────────────
-- One query for a whole page of listings. The ANY($1::uuid[]) form is what
-- keeps listing pages off the N+1 path.

INSERT INTO listing_media (listing_id, storage_key, mime, bytes, position)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'listings/a/1', 'image/jpeg', 1000, 0),
       ('aaaaaaaa-0000-4000-8000-000000000001', 'listings/a/2', 'image/jpeg', 1000, 1),
       ('bbbbbbbb-0000-4000-8000-000000000001', 'listings/b/1', 'image/webp', 1000, 0);

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM listing_media
   WHERE listing_id = ANY(ARRAY['aaaaaaaa-0000-4000-8000-000000000001',
                                'bbbbbbbb-0000-4000-8000-000000000001']::uuid[]);
  PERFORM assert(n = 3, 'batched photo fetch must return every listing''s media');
END;
$$;

-- ── 8. expiry sweep only touches live and paused ───────────────────────────

DO $$
DECLARE swept integer;
BEGIN
  UPDATE listings SET expires_at = now() - interval '1 day'
   WHERE id IN ('aaaaaaaa-0000-4000-8000-000000000001',
                'aaaaaaaa-0000-4000-8000-000000000003');

  WITH picked AS (
    SELECT id FROM listings
     WHERE status IN ('live','paused')
       AND expires_at IS NOT NULL AND expires_at <= now()
     ORDER BY expires_at LIMIT 500
  )
  UPDATE listings SET status = 'expired'
   WHERE id IN (SELECT id FROM picked);
  GET DIAGNOSTICS swept = ROW_COUNT;

  PERFORM assert(swept = 1, 'sweep must expire the live listing only, got ' || swept);
  PERFORM assert(
    (SELECT status FROM listings WHERE id = 'aaaaaaaa-0000-4000-8000-000000000003') = 'draft',
    'an overdue DRAFT must not be expired');
END;
$$;

-- ── 9. a suspended user's session must not resolve ─────────────────────────
-- resolveSession joins users and refuses anything but an active account, so
-- suspension takes effect on the next request rather than at session expiry.

DO $$
DECLARE n integer;
BEGIN
  INSERT INTO sessions (id, user_id, token_hash, csrf_hash,
                        idle_expires_at, absolute_expires_at)
  VALUES ('cccccccc-0000-4000-8000-000000000001',
          '11111111-1111-4111-8111-111111111111',
          '\x01'::bytea, '\x02'::bytea,
          now() + interval '1 hour', now() + interval '7 days');

  UPDATE users SET status = 'suspended'
   WHERE id = '11111111-1111-4111-8111-111111111111';

  SELECT count(*) INTO n
    FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = '\x01'::bytea AND u.status = 'active';

  PERFORM assert(n = 0, 'a suspended user''s live session must not resolve');
END;
$$;

ROLLBACK;

\echo 'listings SQL contract: all assertions passed'
