-- 012: the Regina gazetteer, and the indexes search needs.
--
-- Why a gazetteer at all: the Apple Developer Program Licence Agreement
-- defines "Map Data" to include latitude and longitude and forbids storing it
-- beyond "temporary and limited" use. Portage stores a coordinate per property
-- permanently, so the coordinate cannot come from Apple. The City of Regina
-- publishes ~70k authoritative civic address points as open data, which we may
-- store, and which are more accurate for one city than any global geocoder.
--
-- That is the permitted split: geocode from open data, RENDER on Apple.
--
-- Autocomplete runs against this table rather than mapkit.Search, which dodges
-- both the licence question and Apple's 25k/day service-call quota — and costs
-- nothing per request.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE address_points (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Provenance travels with every row. When a figure or a pin is questioned,
  -- the answer has to be "this record, from this dataset, ingested then".
  source         text NOT NULL,
  source_id      text NOT NULL,
  civic_number   text,
  street_name    text,
  -- Display form, as published.
  full_address   text NOT NULL,
  -- Comparison key, produced by normalizeAddress() in policy.ts. Written by
  -- the application, never derived in SQL: the listing side computes its key
  -- the same way, and two normalizers that drift apart stop matching.
  address_norm   text NOT NULL,
  city           text NOT NULL,
  province       char(2) NOT NULL CHECK (province ~ '^[A-Z]{2}$'),
  postal_code    text,
  lat            double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng            double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  -- Assigned at ingest by point-in-polygon against neighbourhoods.boundary,
  -- so no query ever pays for the containment test.
  neighbourhood_id uuid REFERENCES neighbourhoods(id) ON DELETE SET NULL,
  ingested_at    timestamptz NOT NULL DEFAULT now()
);

-- Re-ingesting the same dataset updates rows rather than duplicating them.
CREATE UNIQUE INDEX address_points_source_idx ON address_points(source, source_id);

-- The autocomplete index. Trigram rather than full-text because the input is
-- a partial address being typed, not a sentence: "123 vic" must match
-- "123 victoria avenue", which no word-stem index will do.
CREATE INDEX address_points_trgm_idx ON address_points
  USING gin (address_norm gin_trgm_ops);

-- Exact-key lookup, used when a listing address is resolved to a coordinate.
CREATE INDEX address_points_norm_idx ON address_points(address_norm, city, province);
CREATE INDEX address_points_hood_idx ON address_points(neighbourhood_id)
  WHERE neighbourhood_id IS NOT NULL;
CREATE INDEX address_points_latlng_idx ON address_points(lat, lng);

-- A bounding box per neighbourhood, so a viewport or radius query can discard
-- most of them with an index range before any polygon work happens. PostGIS
-- would carry this in a GiST index; until it is enabled, four columns do.
ALTER TABLE neighbourhoods
  ADD COLUMN min_lat double precision,
  ADD COLUMN min_lng double precision,
  ADD COLUMN max_lat double precision,
  ADD COLUMN max_lng double precision,
  ADD COLUMN source  text,
  ADD COLUMN source_id text;
CREATE INDEX neighbourhoods_bbox_idx ON neighbourhoods(min_lat, max_lat, min_lng, max_lng)
  WHERE min_lat IS NOT NULL;

-- One row per ingest run. Answers "when did this data last change, from
-- where, and did it shrink" — a dataset that silently halves is the failure
-- mode that matters, and it is invisible without a record of counts.
CREATE TABLE gazetteer_ingests (
  id           bigserial PRIMARY KEY,
  source       text NOT NULL,
  dataset      text NOT NULL,
  fetched_url  text,
  rows_seen    integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  rows_skipped integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','partial','failed')),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX gazetteer_ingests_recent_idx ON gazetteer_ingests(dataset, started_at DESC);

-- ── search indexes ──────────────────────────────────────────────────────────
-- Keyset pagination needs the tiebreaker in the index, or the sort spills to
-- disk on every page past the first. Each of these matches one ORDER BY in
-- modules/search/query.ts exactly; they are partial on status = 'live'
-- because the browse path never looks at anything else.

CREATE INDEX listings_recent_idx ON listings(published_at DESC, id DESC)
  WHERE status = 'live';
-- One index serves BOTH price directions. A btree can be scanned backward, so
-- (price_cents, id) read in reverse is exactly (price_cents DESC, id DESC) --
-- verified in test/sql/gazetteer.sql, where the planner answers the descending
-- sort with "Index Only Scan Backward" over this index. A second descending
-- index would be written on every listing insert and update to serve queries
-- this one already answers.
CREATE INDEX listings_price_asc_idx ON listings(price_cents, id)
  WHERE status = 'live';

-- Map viewport queries filter on the property's coordinate and the listing's
-- status together, so the join column is included to keep it index-only.
CREATE INDEX listings_live_property_idx ON listings(property_id, id)
  WHERE status = 'live';
