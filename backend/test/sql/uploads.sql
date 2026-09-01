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
VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'owner@example.test', 'x', now()),
       -- Sections 7 and 8 need an owner that section 6 does not delete.
       ('bbbbbbbb-9999-4999-8999-999999999999', 'logged@example.test', 'x', now());

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

-- ── 5b. a reserved photo is invisible to every read, not just the gate ────
-- The publish gate (2 above) has always filtered on status. The READ paths did
-- not, which meant a listing rendered a broken <img> for every abandoned
-- upload, and — worse — DISTINCT ON picked the reserved row at position 0 as
-- the cover image on every search result for a listing whose real photos sat
-- behind it.
--
-- Both queries are asserted here in the form the services send, together with
-- their unfiltered twins, so it is visible that the filter is what makes the
-- difference rather than the fixture.

-- Its own listing, so the rows section 2 left behind cannot be mistaken for
-- the fixture this section is about.
INSERT INTO properties (id, address_line, address_norm, city, province)
VALUES ('bbbbbbbb-2222-4222-8222-222222222222', '1845 Rae St',
        '1845 rae street', 'Regina', 'SK');

INSERT INTO listings (id, property_id, owner_id, mode, status, price_cents,
                      property_type, title, description)
VALUES ('cccccccc-2222-4222-8222-222222222222', 'bbbbbbbb-2222-4222-8222-222222222222',
        'aaaaaaaa-1111-4111-8111-111111111111', 'rent', 'draft', 189500, 'detached',
        'Character home near the park',
        'A three bedroom character home a short walk from the park.');

INSERT INTO listing_media (id, listing_id, storage_key, kind, mime, bytes, position, status)
VALUES ('eeeeeeee-1111-4111-8111-111111111111', 'cccccccc-2222-4222-8222-222222222222',
        'listings/c2/p-abandoned', 'photo', 'image/jpeg', 1000, 0, 'pending'),
       ('eeeeeeee-2222-4222-8222-222222222222', 'cccccccc-2222-4222-8222-222222222222',
        'listings/c2/p-real', 'photo', 'image/jpeg', 2000, 1, 'stored');

DO $$
DECLARE n integer; k text;
BEGIN
  -- ListingService.#photosFor
  SELECT count(*) INTO n FROM listing_media
   WHERE listing_id = ANY(ARRAY['cccccccc-2222-4222-8222-222222222222']::uuid[])
     AND status = 'stored';
  PERFORM assert(n = 1, 'a listing view must show only stored photos, got ' || n);

  SELECT count(*) INTO n FROM listing_media
   WHERE listing_id = ANY(ARRAY['cccccccc-2222-4222-8222-222222222222']::uuid[]);
  PERFORM assert(n = 2, 'the unfiltered read would show the abandoned row, got ' || n);

  -- SearchService.#coverPhotos
  SELECT storage_key INTO k FROM (
    SELECT DISTINCT ON (listing_id) listing_id, storage_key
      FROM listing_media
     WHERE listing_id = ANY(ARRAY['cccccccc-2222-4222-8222-222222222222']::uuid[])
       AND kind = 'photo' AND status = 'stored'
     ORDER BY listing_id, position, id
  ) t;
  PERFORM assert(k = 'listings/c2/p-real',
    'the cover must be a photo that exists, got ' || coalesce(k, 'null'));

  SELECT storage_key INTO k FROM (
    SELECT DISTINCT ON (listing_id) listing_id, storage_key
      FROM listing_media
     WHERE listing_id = ANY(ARRAY['cccccccc-2222-4222-8222-222222222222']::uuid[])
       AND kind = 'photo'
     ORDER BY listing_id, position, id
  ) t;
  PERFORM assert(k = 'listings/c2/p-abandoned',
    'without the filter the cover would be the abandoned upload — that is the bug');
END;
$$;

-- ── 5c. the locker lists only documents that actually hold bytes ──────────
-- Same rule as 5b, and the same failure: a reserved row lists with a Download
-- button that leads to nothing, and it counts against the per-user cap of 500
-- so a run of abandoned uploads can lock someone out of their own locker.

INSERT INTO documents (id, owner_id, title, kind, storage_key, mime, bytes,
                       content_hash, retention_until, status)
VALUES ('ffffffff-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-111111111111',
        'Abandoned upload', 'other', 'docs/abandoned', 'application/pdf', 1000,
        sha256('x'::bytea), now() + interval '365 days', 'pending'),
       ('ffffffff-2222-4222-8222-222222222222', 'aaaaaaaa-1111-4111-8111-111111111111',
        'Tenancy agreement', 'agreement', 'docs/real', 'application/pdf', 2000,
        sha256('y'::bytea), now() + interval '365 days', 'stored');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM documents
   WHERE owner_id = 'aaaaaaaa-1111-4111-8111-111111111111'
     AND deleted_at IS NULL AND status = 'stored';
  PERFORM assert(n = 1, 'the locker must list only stored documents, got ' || n);

  SELECT count(*) INTO n FROM documents
   WHERE owner_id = 'aaaaaaaa-1111-4111-8111-111111111111'
     AND deleted_at IS NULL;
  PERFORM assert(n = 2, 'the unfiltered read would list the abandoned row, got ' || n);
END;
$$;

-- ── 5d. what the retention purge must find ─────────────────────────────────
-- Two categories, and the second was the bug: remove() soft-deletes and its
-- comment promised "the retention job purges the bytes", while the query
-- filtered `deleted_at IS NULL` — so an owner-deleted document was never
-- collected and its bytes stayed in the bucket indefinitely.

INSERT INTO documents (id, owner_id, title, kind, storage_key, mime, bytes,
                       content_hash, retention_until, status, deleted_at)
VALUES ('ffffffff-3333-4333-8333-333333333333', 'aaaaaaaa-1111-4111-8111-111111111111',
        'Past its retention date', 'other', 'docs/expired', 'application/pdf', 1,
        sha256('a'::bytea), now() - interval '1 day', 'stored', NULL),
       ('ffffffff-4444-4444-8444-444444444444', 'aaaaaaaa-1111-4111-8111-111111111111',
        'Deleted by its owner', 'other', 'docs/removed', 'application/pdf', 1,
        sha256('b'::bytea), now() + interval '365 days', 'stored', now()),
       ('ffffffff-5555-4555-8555-555555555555', 'aaaaaaaa-1111-4111-8111-111111111111',
        'Still wanted', 'other', 'docs/live', 'application/pdf', 1,
        sha256('c'::bytea), now() + interval '365 days', 'stored', NULL);

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM documents
   WHERE purged_at IS NULL
     AND (retention_until <= now() OR deleted_at IS NOT NULL)
     AND owner_id = 'aaaaaaaa-1111-4111-8111-111111111111';
  PERFORM assert(n = 2,
    'both an expired document AND one its owner deleted must be candidates, got ' || n);

  -- Purging is idempotent: a row that has been done is never a candidate again.
  UPDATE documents SET purged_at = now(), title = '(deleted)'
   WHERE id = 'ffffffff-3333-4333-8333-333333333333';

  SELECT count(*) INTO n FROM documents
   WHERE purged_at IS NULL
     AND (retention_until <= now() OR deleted_at IS NOT NULL)
     AND owner_id = 'aaaaaaaa-1111-4111-8111-111111111111';
  PERFORM assert(n = 1, 'a purged row must not be collected again, got ' || n);
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

-- ── 7. the access log outlives the purge, and cannot be erased ────────────
-- This is why a purged document is blanked rather than deleted: the log
-- references it and carries a forbid_mutation trigger, so a cascade delete
-- would be refused. An access trail you can erase is not one.

INSERT INTO documents (id, owner_id, title, kind, storage_key, mime, bytes,
                       content_hash, retention_until, status)
VALUES ('ffffffff-6666-4666-8666-666666666666', 'bbbbbbbb-9999-4999-8999-999999999999',
        'Logged', 'other', 'docs/logged', 'application/pdf', 1,
        sha256('d'::bytea), now() + interval '365 days', 'stored');

INSERT INTO document_access_log (document_id, actor_id, action)
VALUES ('ffffffff-6666-4666-8666-666666666666',
        'bbbbbbbb-9999-4999-8999-999999999999', 'upload');

DO $$
DECLARE raised boolean := false; n integer;
BEGIN
  BEGIN
    DELETE FROM document_access_log
     WHERE document_id = 'ffffffff-6666-4666-8666-666666666666';
  EXCEPTION WHEN OTHERS THEN raised := true;
  END;
  PERFORM assert(raised, 'the access log must refuse deletion');

  SELECT count(*) INTO n FROM document_access_log
   WHERE document_id = 'ffffffff-6666-4666-8666-666666666666';
  PERFORM assert(n = 1, 'and the entry must survive a purge of the document');
END;
$$;

-- ── 8. KNOWN GAP: an account with a logged document cannot be deleted ──────
--
-- Two rules that are each correct and collide. `documents.owner_id` cascades
-- from `users`, and `document_access_log.document_id` cascades from
-- `documents` — but that log is append-only at the database level, so the
-- cascade is refused and the user delete fails outright.
--
-- The consequence is that the PIPEDA erasure path does not work for anyone who
-- ever uploaded a document and opened it. Section 6 above passes only because
-- its fixture has no log rows; the moment one exists, deletion stops.
--
-- This asserts the CURRENT behaviour so the gap is visible and tested rather
-- than latent. It is not an endorsement: resolving it needs a decision about
-- whether the trail survives an account deletion in pseudonymised form (likely
-- right — it records staff and third-party access, not only the owner's) or
-- whether the trigger should permit a cascade. When that decision is made,
-- THIS ASSERTION WILL FAIL, which is the intended way to be reminded.

DO $$
DECLARE refused boolean := false;
BEGIN
  BEGIN
    DELETE FROM users WHERE id = 'bbbbbbbb-9999-4999-8999-999999999999';
  EXCEPTION WHEN OTHERS THEN refused := true;
  END;
  PERFORM assert(refused,
    'deleting a user with a logged document is currently refused — if this now '
    || 'succeeds, the erasure gap has been fixed and this contract needs updating');
END;
$$;

ROLLBACK;

\echo 'uploads SQL contract: all assertions passed'
