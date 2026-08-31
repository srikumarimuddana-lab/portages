-- Verifies the upload lifecycle against the real schema.
--
-- The TypeScript tests prove what UploadService decides. These prove the
-- database will hold it — in particular that a reserved photo row cannot be
-- mistaken for a stored one, which is the whole reason the status column
-- exists.

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

INSERT INTO users (id, email, password_hash, email_verified_at)
VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'owner@example.test', 'x', now());

INSERT INTO properties (id, address_line, address_norm, city, province)
VALUES ('bbbbbbbb-1111-4111-8111-111111111111', '2100 Victoria Ave',
        '2100 victoria avenue', 'Regina', 'SK');

INSERT INTO listings (id, property_id, owner_id, mode, status, price_cents,
                      property_type, title, description)
VALUES ('cccccccc-1111-4111-8111-111111111111', 'bbbbbbbb-1111-4111-8111-111111111111',
        'aaaaaaaa-1111-4111-8111-111111111111', 'rent', 'draft', 150000, 'apartment',
        'Bright two bedroom in Cathedral',
        'A well-kept two bedroom a short walk from the park and shops.');

-- ── 1. a storage key can only be claimed once ──────────────────────────────
-- Two uploads pointing at one object would let the second overwrite the
-- first's bytes after the first had already been verified.

INSERT INTO uploads (owner_id, subject_type, subject_id, storage_key,
                     declared_mime, declared_bytes, expires_at)
VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'listing_media',
        'cccccccc-1111-4111-8111-111111111111', 'listings/c/p1',
        'image/jpeg', 1000, now() + interval '15 minutes');

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO uploads (owner_id, subject_type, subject_id, storage_key,
                         declared_mime, declared_bytes, expires_at)
    VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'listing_media',
            'cccccccc-1111-4111-8111-111111111111', 'listings/c/p1',
            'image/jpeg', 1000, now() + interval '15 minutes');
  EXCEPTION WHEN unique_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'a storage key must not be claimable twice');
END;
$$;

-- ── 2. a reserved photo does not count toward publish readiness ────────────
-- The publish check counts photos WHERE status = 'stored'. Without that, a
-- listing could be submitted on the strength of an upload that never arrived.

INSERT INTO listing_media (id, listing_id, storage_key, mime, bytes, position, status)
VALUES ('dddddddd-1111-4111-8111-111111111111', 'cccccccc-1111-4111-8111-111111111111',
        'listings/c/p1', 'image/jpeg', 1000, 0, 'pending');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM listing_media
   WHERE listing_id = 'cccccccc-1111-4111-8111-111111111111'
     AND kind = 'photo' AND status = 'stored';
  PERFORM assert(n = 0, 'a pending photo must not count as stored, got ' || n);

  UPDATE listing_media SET status = 'stored'
   WHERE id = 'dddddddd-1111-4111-8111-111111111111';

  SELECT count(*) INTO n FROM listing_media
   WHERE listing_id = 'cccccccc-1111-4111-8111-111111111111'
     AND kind = 'photo' AND status = 'stored';
  PERFORM assert(n = 1, 'a completed photo must count, got ' || n);
END;
$$;

-- ── 3. the completion write records what was actually observed ─────────────

DO $$
DECLARE r record;
BEGIN
  UPDATE uploads
     SET status = 'stored', verified_mime = 'image/jpeg', verified_bytes = 812,
         content_hash = sha256('stripped bytes'::bytea),
         metadata_stripped = ARRAY['EXIF','XMP'], had_gps = true,
         exif_orientation = 6, completed_at = now()
   WHERE storage_key = 'listings/c/p1';

  SELECT * INTO r FROM uploads WHERE storage_key = 'listings/c/p1';
  PERFORM assert(r.status = 'stored', 'status must be stored');
  PERFORM assert(r.verified_bytes = 812,
    'the verified size must be the observed one, not the declared 1000');
  PERFORM assert(r.declared_bytes = 1000,
    'the declared size is kept alongside it, not overwritten');
  PERFORM assert(r.had_gps, 'the GPS finding must be recorded');
  PERFORM assert(r.metadata_stripped @> ARRAY['EXIF'], 'what was stripped must be recorded');
END;
$$;

-- ── 4. an impossible orientation is refused by the database ────────────────

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    UPDATE uploads SET exif_orientation = 99 WHERE storage_key = 'listings/c/p1';
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised, 'EXIF orientation must be constrained to 1-8');
END;
$$;

-- ── 5. the sweeper finds abandoned tickets and nothing else ────────────────

INSERT INTO uploads (owner_id, subject_type, subject_id, storage_key,
                     declared_mime, declared_bytes, expires_at, status)
VALUES
  ('aaaaaaaa-1111-4111-8111-111111111111', 'listing_media',
   'cccccccc-1111-4111-8111-111111111111', 'listings/c/abandoned',
   'image/jpeg', 1000, now() - interval '2 hours', 'pending'),
  ('aaaaaaaa-1111-4111-8111-111111111111', 'listing_media',
   'cccccccc-1111-4111-8111-111111111111', 'listings/c/fresh',
   'image/jpeg', 1000, now() + interval '10 minutes', 'pending');

DO $$
DECLARE swept integer;
BEGIN
  WITH picked AS (
    SELECT id FROM uploads
     WHERE status = 'pending' AND expires_at < now() - interval '1 hour'
     ORDER BY expires_at LIMIT 200
  )
  UPDATE uploads SET status = 'expired' WHERE id IN (SELECT id FROM picked);
  GET DIAGNOSTICS swept = ROW_COUNT;

  PERFORM assert(swept = 1, 'only the abandoned ticket may be swept, got ' || swept);
  PERFORM assert(
    (SELECT status FROM uploads WHERE storage_key = 'listings/c/fresh') = 'pending',
    'a ticket still within its window must be left alone');
  PERFORM assert(
    (SELECT status FROM uploads WHERE storage_key = 'listings/c/p1') = 'stored',
    'a completed upload must never be swept');
END;
$$;

-- ── 6. deleting a user takes their uploads with them ───────────────────────
-- PIPEDA: an account deletion that leaves upload records behind has not
-- deleted the account.

DO $$
DECLARE n integer;
BEGIN
  DELETE FROM listings WHERE owner_id = 'aaaaaaaa-1111-4111-8111-111111111111';
  DELETE FROM users WHERE id = 'aaaaaaaa-1111-4111-8111-111111111111';
  SELECT count(*) INTO n FROM uploads
   WHERE owner_id = 'aaaaaaaa-1111-4111-8111-111111111111';
  PERFORM assert(n = 0, 'uploads must cascade with the user, ' || n || ' left');
END;
$$;

ROLLBACK;

\echo 'uploads SQL contract: all assertions passed'
