-- 008: neighbourhoods, scores, valuation.
-- Data provenance note: MLS listings and sold prices are NOT available to a
-- non-member platform (CREA's DDF requires membership and a Data Access
-- Agreement; scraping Realtor.ca breaches its terms). These tables are fed
-- from open data (SAMA assessments, City of Regina open data, Regina Transit
-- GTFS) plus our own listings.

CREATE TABLE neighbourhoods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  city        text NOT NULL,
  province    char(2) NOT NULL,
  -- GeoJSON polygon. Upgrade path: ALTER to geography(Polygon,4326) once
  -- PostGIS is enabled, then swap the containment query in the geo module.
  boundary    jsonb,
  centroid_lat double precision,
  centroid_lng double precision,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX neighbourhoods_name_idx ON neighbourhoods(city, province, name);

ALTER TABLE properties
  ADD CONSTRAINT properties_neighbourhood_fk
  FOREIGN KEY (neighbourhood_id) REFERENCES neighbourhoods(id) ON DELETE SET NULL;

CREATE TABLE neighbourhood_scores (
  neighbourhood_id uuid NOT NULL REFERENCES neighbourhoods(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('transit','schools','quiet','amenities')),
  value            numeric(5,2) NOT NULL CHECK (value BETWEEN 0 AND 100),
  -- Every derived number carries its method version and inputs so the figure
  -- shown to a consumer can be explained and reproduced.
  method_version   text NOT NULL,
  inputs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (neighbourhood_id, kind)
);

-- AVM output. Deliberately carries a range and a confidence, never a bare
-- number: the estimate is guidance, not an appraisal, and publishing the
-- error band is both more defensible and better marketing than false
-- precision. The AVM is a comparables algorithm, NOT an LLM.
CREATE TABLE avm_estimates (
  property_id   uuid PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  value_cents   bigint NOT NULL CHECK (value_cents > 0),
  low_cents     bigint NOT NULL CHECK (low_cents > 0),
  high_cents    bigint NOT NULL CHECK (high_cents > 0),
  confidence    numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  comp_count    smallint NOT NULL CHECK (comp_count >= 0),
  model_version text NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT avm_band_ordered CHECK (low_cents <= value_cents AND value_cents <= high_cents)
);

CREATE TABLE comparables (
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  comp_property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  similarity       numeric(4,3) NOT NULL CHECK (similarity BETWEEN 0 AND 1),
  source           text NOT NULL CHECK (source IN ('portage_listing','assessment','owner_reported')),
  observed_price_cents bigint CHECK (observed_price_cents IS NULL OR observed_price_cents > 0),
  observed_at      timestamptz,
  PRIMARY KEY (property_id, comp_property_id),
  CONSTRAINT comparable_not_self CHECK (property_id <> comp_property_id)
);
CREATE INDEX comparables_lookup_idx ON comparables(property_id, similarity DESC);
