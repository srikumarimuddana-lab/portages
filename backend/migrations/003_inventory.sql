-- 003: properties and listings.

CREATE TABLE properties (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address_line   text NOT NULL,
  unit           text,
  -- Normalized form used for duplicate detection; unique per city.
  address_norm   text NOT NULL,
  city           text NOT NULL,
  province       char(2) NOT NULL CHECK (province ~ '^[A-Z]{2}$'),
  postal_code    text CHECK (postal_code IS NULL OR postal_code ~ '^[A-Za-z][0-9][A-Za-z] ?[0-9][A-Za-z][0-9]$'),
  lat            double precision CHECK (lat BETWEEN -90 AND 90),
  lng            double precision CHECK (lng BETWEEN -180 AND 180),
  neighbourhood_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX properties_addr_idx ON properties(address_norm, city, province);
-- Bounding-box prefilter for map/radius search without PostGIS.
CREATE INDEX properties_latlng_idx ON properties(lat, lng)
  WHERE lat IS NOT NULL AND lng IS NOT NULL;
CREATE TRIGGER properties_updated BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE listings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode          text NOT NULL CHECK (mode IN ('sale','rent')),
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','pending_review','live','paused',
                                  'rejected','rented','sold','expired')),
  price_cents   bigint NOT NULL CHECK (price_cents > 0 AND price_cents < 100000000000),
  room_type     text CHECK (room_type IN ('entire','private','shared')),
  property_type text NOT NULL CHECK (property_type IN
                ('detached','semi_detached','condo','townhouse','apartment','cabin','land')),
  beds          smallint CHECK (beds BETWEEN 0 AND 50),
  baths         numeric(3,1) CHECK (baths BETWEEN 0 AND 50),
  sqft          integer CHECK (sqft BETWEEN 0 AND 100000),
  amenities     text[] NOT NULL DEFAULT '{}',
  title         text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  description   text CHECK (description IS NULL OR length(description) <= 8000),
  -- Provenance for AI-written copy. An AI description may not go live until
  -- the owner has attested to it (enforced in 006 by listing_publishable).
  description_source text NOT NULL DEFAULT 'human'
                CHECK (description_source IN ('human','ai_assisted','ai_generated')),
  description_attested_at timestamptz,
  published_at  timestamptz,
  expires_at    timestamptz,
  search_text   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listings_browse_idx ON listings(status, mode, price_cents)
  WHERE status = 'live';
CREATE INDEX listings_owner_idx ON listings(owner_id);
CREATE INDEX listings_property_idx ON listings(property_id);
CREATE INDEX listings_amenities_idx ON listings USING gin(amenities);
CREATE INDEX listings_fts_idx ON listings
  USING gin(to_tsvector('english', coalesce(search_text, '')));
CREATE TRIGGER listings_updated BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A property may hold only one live listing at a time (anti-duplicate).
CREATE UNIQUE INDEX listings_one_live_per_property
  ON listings(property_id) WHERE status = 'live';

CREATE TABLE listing_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  kind        text NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo','tour_3d','floorplan')),
  mime        text NOT NULL,
  bytes       bigint NOT NULL CHECK (bytes > 0),
  position    smallint NOT NULL DEFAULT 0,
  -- Perceptual hash: detects photos stolen from other listings (B1).
  phash       bytea,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listing_media_listing_idx ON listing_media(listing_id, position);
CREATE INDEX listing_media_phash_idx ON listing_media(phash) WHERE phash IS NOT NULL;

CREATE TABLE listing_events (
  id         bigserial PRIMARY KEY,
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('view','save','unsave','message','share')),
  -- Viewer identity is hashed: analytics without storing who browsed what.
  actor_hash bytea,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listing_events_listing_idx ON listing_events(listing_id, kind, at DESC);
