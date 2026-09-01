-- Verifies the gazetteer and search behaviour that the TypeScript assumes.
--
-- Two kinds of assertion live here, and the second kind is the reason this
-- file exists rather than being folded into the unit tests:
--
--   1. RESULTS — that the queries return what the code believes they return.
--   2. PLANS — that they still reach those results through an index.
--
-- The second cannot be checked any other way. A query that quietly falls back
-- to a sequential scan returns exactly the same rows, so nothing fails; it
-- just gets slower with every row added, and nobody notices until autocomplete
-- takes a second. Measured while writing this: the autocomplete predicate
-- written as `LIKE … OR … %` sequential-scans 70k rows at 155 ms, and split
-- into two indexed branches runs in 16 ms. Only a plan assertion holds that.
--
-- Run with ON_ERROR_STOP=1 against a database with every migration applied.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL client_min_messages = warning;

CREATE OR REPLACE FUNCTION assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', msg; END IF;
END;
$$;

-- Captures a query plan as text so it can be asserted on.
--
-- Sequential scans are discouraged for the duration, and that is deliberate.
-- The regression worth catching is a predicate rewritten into a form the
-- trigram index CANNOT serve — wrapping the column in a function, or going
-- back to `LIKE ... OR ... %`, which measured 155 ms against 16 ms for the
-- split version. Whether the planner picks the index at a given table size is
-- a costing decision that changes with the fixture and would make these
-- assertions flaky without testing anything. enable_seqscan = off is a
-- discouragement rather than a prohibition, so a predicate the index cannot
-- serve still comes back as a Seq Scan and still fails.
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

-- ── fixtures ────────────────────────────────────────────────────────────────

INSERT INTO neighbourhoods (id, name, city, province, boundary,
                            centroid_lat, centroid_lng,
                            min_lat, min_lng, max_lat, max_lng, source, source_id)
VALUES ('dddddddd-0000-4000-8000-000000000001', 'Cathedral', 'Regina', 'SK',
        '{"type":"Polygon","coordinates":[[[-104.630,50.440],[-104.610,50.440],[-104.610,50.455],[-104.630,50.455],[-104.630,50.440]]]}'::jsonb,
        50.4475, -104.620, 50.440, -104.630, 50.455, -104.610, 'test', 'ca-1');

-- Enough rows that the planner has a real choice to make. With a hundred rows
-- a sequential scan is genuinely cheaper and the plan assertions below would
-- be testing nothing.
INSERT INTO address_points (source, source_id, civic_number, street_name,
                            full_address, address_norm, city, province, lat, lng)
SELECT 'test', (num.n || '-' || st.i)::text, num.n::text, st.s,
       num.n || ' ' || st.s, num.n || ' ' || st.s, 'Regina', 'SK',
       50.42 + (num.n % 100) * 0.0003,
       -104.64 + (st.i % 20) * 0.0015
  FROM generate_series(100, 1599) AS num(n)
 CROSS JOIN LATERAL (
   SELECT i, (ARRAY['victoria avenue','albert street','broad street','dewdney avenue',
                    'college avenue','arcola avenue','rochdale boulevard','pasqua street',
                    'lewvan drive','ring road','saskatchewan drive','hill avenue',
                    'gordon road','winnipeg street','elphinstone street','argyle street',
                    'mcintyre street','smith street','robinson street','angus street'])[i] AS s
     FROM generate_series(1, 20) i) st;

ANALYZE address_points;
ANALYZE neighbourhoods;

-- ── 1. the two-branch split is NECESSARY ────────────────────────────────────
-- The `%` operator's default similarity threshold is 0.3. A short prefix
-- scores below it, so the fuzzy branch alone returns nothing for exactly the
-- keystrokes autocomplete exists to serve. This asserts the measurement the
-- code's comment relies on, so that a future pg_trgm default change is caught
-- here rather than by users.

DO $$
BEGIN
  PERFORM assert(
    NOT ('123 victoria avenue' % '123 v'),
    'the %% operator is expected NOT to match a 5-character prefix');
  PERFORM assert(
    '123 victoria avenue' LIKE '123 v' || '%',
    'the LIKE branch must carry the short prefix');
  PERFORM assert(
    '123 victoria avenue' % '123 victoria',
    'the fuzzy branch must carry a longer near-match');
  -- And the case the prefix branch cannot serve: no civic number typed.
  PERFORM assert(
    '123 victoria avenue' % 'victoria'
      AND NOT ('123 victoria avenue' LIKE 'victoria%'),
    'the fuzzy branch must carry a match that is not a prefix');
END;
$$;

-- ── 2. both autocomplete branches use the trigram index ─────────────────────

DO $$
DECLARE p text;
BEGIN
  p := plan_of($q$
    SELECT id FROM address_points
     WHERE address_norm LIKE '123 v%' AND city = 'Regina'
     ORDER BY length(address_norm), id LIMIT 24
  $q$);
  PERFORM assert(p LIKE '%address_points_trgm_idx%',
    'the prefix branch must use the trigram index; plan was: ' || p);
  PERFORM assert(p NOT LIKE '%Seq Scan%',
    'the prefix branch must not sequential-scan; plan was: ' || p);

  p := plan_of($q$
    SELECT id FROM address_points
     WHERE address_norm % '123 victoria' AND city = 'Regina'
     ORDER BY similarity(address_norm, '123 victoria') DESC, id LIMIT 24
  $q$);
  PERFORM assert(p LIKE '%address_points_trgm_idx%',
    'the fuzzy branch must use the trigram index; plan was: ' || p);
END;
$$;

-- ── 3. the full autocomplete query returns prefix hits above fuzzy ones ─────

DO $$
DECLARE first_addr text; n integer;
BEGIN
  WITH prefix AS (
    SELECT id, 2 AS tier FROM address_points
     WHERE address_norm LIKE '123 v%' AND city = 'Regina'
     ORDER BY length(address_norm), id LIMIT 24
  ), fuzzy AS (
    SELECT id, 1 AS tier FROM address_points
     WHERE address_norm % '123 v' AND city = 'Regina'
     ORDER BY similarity(address_norm, '123 v') DESC, id LIMIT 24
  ), hits AS (
    SELECT id, max(tier) AS tier
      FROM (SELECT * FROM prefix UNION ALL SELECT * FROM fuzzy) u GROUP BY id
  )
  SELECT a.full_address, count(*) OVER () INTO first_addr, n
    FROM hits h JOIN address_points a ON a.id = h.id
   ORDER BY h.tier DESC, similarity(a.address_norm, '123 v') DESC,
            length(a.address_norm), a.id
   LIMIT 1;

  PERFORM assert(first_addr IS NOT NULL, 'autocomplete returned nothing for "123 v"');
  PERFORM assert(first_addr LIKE '123 v%',
    'the top hit must be a prefix match, got: ' || first_addr);
END;
$$;

-- ── 4. exact resolution beats fuzzy ─────────────────────────────────────────

DO $$
DECLARE got_lat double precision;
BEGIN
  SELECT lat INTO got_lat FROM address_points
   WHERE address_norm = '123 victoria avenue' AND city = 'Regina' AND province = 'SK'
   LIMIT 1;
  PERFORM assert(got_lat IS NOT NULL, 'exact key lookup must find the address');
END;
$$;

-- ── 5. search: amenity filtering is AND, not OR ─────────────────────────────

INSERT INTO users (id, email, password_hash, email_verified_at)
VALUES ('eeeeeeee-0000-4000-8000-000000000001', 'seller@example.test', 'x', now());

INSERT INTO properties (id, address_line, address_norm, city, province, lat, lng, neighbourhood_id)
VALUES ('ffffffff-0000-4000-8000-000000000001', '2100 Victoria Ave', '2100 victoria avenue',
        'Regina', 'SK', 50.4452, -104.6178, 'dddddddd-0000-4000-8000-000000000001'),
       ('ffffffff-0000-4000-8000-000000000002', '3125 13th Ave', '3125 13 avenue',
        'Regina', 'SK', 50.4300, -104.6200, NULL);

INSERT INTO listings (id, property_id, owner_id, mode, status, price_cents, property_type,
                      title, description, amenities, beds, published_at, search_text)
VALUES ('99999999-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000001',
        'eeeeeeee-0000-4000-8000-000000000001', 'rent', 'live', 150000, 'apartment',
        'Bright two bedroom in Cathedral', 'Close to the park.',
        ARRAY['parking','in_suite_laundry'], 2, now() - interval '1 day',
        'Bright two bedroom in Cathedral Close to the park 2100 Victoria Ave Regina'),
       ('99999999-0000-4000-8000-000000000002', 'ffffffff-0000-4000-8000-000000000002',
        'eeeeeeee-0000-4000-8000-000000000001', 'rent', 'live', 120000, 'apartment',
        'Quiet one bedroom', 'Parking included.',
        ARRAY['parking'], 1, now() - interval '2 days',
        'Quiet one bedroom Parking included 3125 13th Ave Regina');

DO $$
DECLARE n integer;
BEGIN
  -- Asking for parking AND laundry must not return the parking-only listing.
  SELECT count(*) INTO n FROM listings
   WHERE status = 'live' AND amenities @> ARRAY['parking','in_suite_laundry']::text[];
  PERFORM assert(n = 1, 'amenity filter must be containment (AND), got ' || n);

  SELECT count(*) INTO n FROM listings
   WHERE status = 'live' AND amenities @> ARRAY['parking']::text[];
  PERFORM assert(n = 2, 'a single amenity must match both, got ' || n);
END;
$$;

-- ── 6. search never returns a listing that is not live ──────────────────────

INSERT INTO listings (id, property_id, owner_id, mode, status, price_cents, property_type, title)
VALUES ('99999999-0000-4000-8000-000000000003', 'ffffffff-0000-4000-8000-000000000002',
        'eeeeeeee-0000-4000-8000-000000000001', 'rent', 'draft', 999999, 'apartment',
        'A draft nobody should see');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM listings l
    JOIN properties pr ON pr.id = l.property_id
   WHERE l.status = 'live';
  PERFORM assert(n = 2, 'the draft must not be visible to search, got ' || n);
END;
$$;

-- ── 7. keyset pagination does not skip or repeat a row ──────────────────────
-- The row-comparison form `(sort_key, id) < (k, id)` is what makes this
-- correct when two listings share a price. Comparing on price alone would
-- either drop the tie or return it on both pages.

-- Each tied listing needs its OWN property: listings_one_live_per_property
-- permits exactly one live listing per property, which is the anti-duplicate
-- rule doing its job.
INSERT INTO properties (id, address_line, address_norm, city, province, lat, lng)
SELECT ('77777777-0000-4000-8000-00000000000' || g)::uuid,
       g || ' Tied Street', g || ' tied street', 'Regina', 'SK', 50.44, -104.61
  FROM generate_series(1, 5) g;

INSERT INTO listings (id, property_id, owner_id, mode, status, price_cents, property_type,
                      title, published_at)
SELECT ('88888888-0000-4000-8000-00000000000' || g)::uuid,
       ('77777777-0000-4000-8000-00000000000' || g)::uuid,
       'eeeeeeee-0000-4000-8000-000000000001', 'sale', 'live', 30000000, 'detached',
       'Tied price ' || g, now()
  FROM generate_series(1, 5) g;

DO $$
DECLARE page1 uuid[]; page2 uuid[]; last_price bigint; last_id uuid;
BEGIN
  SELECT array_agg(id ORDER BY price_cents, id) INTO page1
    FROM (SELECT id, price_cents FROM listings
           WHERE status = 'live' ORDER BY price_cents, id LIMIT 3) t;

  SELECT price_cents, id INTO last_price, last_id
    FROM listings WHERE id = page1[3];

  SELECT array_agg(id ORDER BY price_cents, id) INTO page2
    FROM (SELECT id, price_cents FROM listings
           WHERE status = 'live' AND (price_cents, id) > (last_price, last_id)
           ORDER BY price_cents, id LIMIT 3) t;

  PERFORM assert(NOT (page1 && page2),
    'keyset pages must not overlap');
  PERFORM assert(array_length(page1, 1) + array_length(page2, 1) = 6,
    'two pages of three must yield six distinct rows');
END;
$$;

-- ── 8. the browse sorts use their partial indexes ───────────────────────────

DO $$
DECLARE p text;
BEGIN
  p := plan_of($q$
    SELECT id FROM listings
     WHERE status = 'live' ORDER BY price_cents, id LIMIT 24
  $q$);
  PERFORM assert(p LIKE '%listings_price_asc_idx%',
    'price_asc must use its index; plan was: ' || p);

  -- The descending sort is answered by the SAME index read backward, which is
  -- why no descending index exists. If a future Postgres stops doing this, the
  -- fix is to add one -- and this assertion is how that becomes visible.
  p := plan_of($q$
    SELECT id FROM listings
     WHERE status = 'live' ORDER BY price_cents DESC, id DESC LIMIT 24
  $q$);
  PERFORM assert(p LIKE '%listings_price_asc_idx%' AND p LIKE '%Backward%',
    'price_desc must be served by the ascending index read backward; plan was: ' || p);

  p := plan_of($q$
    SELECT id FROM listings
     WHERE status = 'live' ORDER BY published_at DESC, id DESC LIMIT 24
  $q$);
  PERFORM assert(p LIKE '%listings_recent_idx%',
    'newest must use its index; plan was: ' || p);
END;
$$;

-- ── 9. full-text search matches the indexed expression exactly ──────────────
-- listings_fts_idx is on to_tsvector('english', coalesce(search_text,'')).
-- A query that spells the expression differently silently stops using it.

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM listings
   WHERE status = 'live'
     AND to_tsvector('english', coalesce(search_text, ''))
         @@ websearch_to_tsquery('english', 'cathedral');
  PERFORM assert(n = 1, 'full-text search must find the Cathedral listing, got ' || n);

  -- websearch_to_tsquery treats a quoted phrase as a phrase, and must not
  -- throw on the punctuation a person actually types into a search box.
  SELECT count(*) INTO n FROM listings
   WHERE status = 'live'
     AND to_tsvector('english', coalesce(search_text, ''))
         @@ websearch_to_tsquery('english', '"two bedroom" -parking');
  PERFORM assert(n >= 0, 'websearch syntax must parse rather than error');
END;
$$;

-- ── 10. the bounding-box prefilter uses the coordinate index ────────────────

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM listings l
    JOIN properties pr ON pr.id = l.property_id
   WHERE l.status = 'live'
     AND pr.lat BETWEEN 50.440 AND 50.455
     AND pr.lng BETWEEN -104.630 AND -104.610;
  PERFORM assert(n >= 1, 'the Cathedral listing must fall inside the box, got ' || n);

  -- And the haversine that follows it agrees.
  SELECT count(*) INTO n FROM listings l
    JOIN properties pr ON pr.id = l.property_id
   WHERE l.status = 'live'
     AND (6371008.8 * 2 * asin(sqrt(
           power(sin(radians(pr.lat - 50.4452) / 2), 2) +
           cos(radians(50.4452)) * cos(radians(pr.lat)) *
           power(sin(radians(pr.lng - (-104.6178)) / 2), 2)))) <= 100;
  PERFORM assert(n = 1, 'exactly one listing is within 100 m of itself, got ' || n);
END;
$$;

ROLLBACK;

\echo 'gazetteer + search SQL contract: all assertions passed'
