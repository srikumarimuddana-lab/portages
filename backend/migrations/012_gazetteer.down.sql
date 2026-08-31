-- Reverses 012.
--
-- pg_trgm is deliberately NOT dropped. Extensions are shared across the whole
-- database and another table may already depend on one; a down-migration that
-- removes a shared object does more than reverse its own change.

DROP INDEX IF EXISTS listings_live_property_idx;
DROP INDEX IF EXISTS listings_price_asc_idx;
DROP INDEX IF EXISTS listings_recent_idx;

DROP TABLE IF EXISTS gazetteer_ingests;

DROP INDEX IF EXISTS neighbourhoods_bbox_idx;
ALTER TABLE neighbourhoods
  DROP COLUMN IF EXISTS source_id,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS max_lng,
  DROP COLUMN IF EXISTS max_lat,
  DROP COLUMN IF EXISTS min_lng,
  DROP COLUMN IF EXISTS min_lat;

-- Indexes on address_points go with the table.
DROP TABLE IF EXISTS address_points;
