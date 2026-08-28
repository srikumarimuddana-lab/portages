-- 007: home-services marketplace (E1-E5).
-- Model is homeowner-choice: the homeowner selects which pros may contact
-- them. We never sell one lead to five pros (Angi burned 81% of its network
-- lead volume to escape that model; Thumbtack's version drew 1,000+ BBB
-- complaints).

CREATE TABLE pros (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  business_name text NOT NULL CHECK (length(business_name) BETWEEN 2 AND 200),
  categories    text[] NOT NULL DEFAULT '{}',
  city          text NOT NULL,
  province      char(2) NOT NULL,
  blurb         text CHECK (blurb IS NULL OR length(blurb) <= 2000),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','active','suspended','rejected')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pros_search_idx ON pros(city, status);
CREATE INDEX pros_categories_idx ON pros USING gin(categories);
CREATE TRIGGER pros_updated BEFORE UPDATE ON pros
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The evidence file behind any "vetted & insured" claim. Saying it without
-- this is a Competition Act s.74.01 exposure. In SK, TSASK licenses electrical
-- and gas contractors; electrician, plumber, refrigeration/AC, sheet metal and
-- sprinkler fitter are compulsory-apprenticeship trades.
CREATE TABLE pro_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pro_id      uuid NOT NULL REFERENCES pros(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('trade_licence','insurance','wcb','business_licence')),
  reference   text NOT NULL,
  issuer      text,
  verified_at timestamptz,
  expires_at  timestamptz,
  evidence_key text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pro_credentials_pro_idx ON pro_credentials(pro_id, kind);
CREATE INDEX pro_credentials_expiry_idx ON pro_credentials(expires_at)
  WHERE verified_at IS NOT NULL;

-- A pro may be shown as verified only while every required credential is
-- verified and unexpired. Computed, never a manually-set boolean.
CREATE VIEW pro_verification_status AS
SELECT p.id AS pro_id,
       bool_and(c.verified_at IS NOT NULL
                AND (c.expires_at IS NULL OR c.expires_at > now()))
         FILTER (WHERE c.kind IN ('trade_licence','insurance')) AS is_verified,
       min(c.expires_at) FILTER (WHERE c.expires_at IS NOT NULL) AS next_expiry
FROM pros p LEFT JOIN pro_credentials c ON c.pro_id = p.id
GROUP BY p.id;

CREATE TABLE quote_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  homeowner_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      text NOT NULL,
  detail        text NOT NULL CHECK (length(detail) BETWEEN 1 AND 4000),
  property_id   uuid REFERENCES properties(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','expired')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quote_requests_owner_idx ON quote_requests(homeowner_id, created_at DESC);

-- The homeowner explicitly picks each pro. A row here IS the consent to contact.
CREATE TABLE quote_recipients (
  quote_request_id uuid NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
  pro_id           uuid NOT NULL REFERENCES pros(id) ON DELETE CASCADE,
  selected_at      timestamptz NOT NULL DEFAULT now(),
  responded_at     timestamptz,
  PRIMARY KEY (quote_request_id, pro_id)
);

CREATE TABLE bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_request_id uuid REFERENCES quote_requests(id) ON DELETE SET NULL,
  pro_id           uuid NOT NULL REFERENCES pros(id) ON DELETE RESTRICT,
  homeowner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested','accepted','declined','completed','cancelled')),
  scheduled_for    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookings_pro_idx ON bookings(pro_id, created_at DESC);
CREATE TRIGGER bookings_updated BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  text NOT NULL CHECK (subject_type IN ('pro','listing','building')),
  subject_id    uuid NOT NULL,
  author_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating        smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          text CHECK (body IS NULL OR length(body) <= 4000),
  -- Reviews require a verifiable basis (a completed booking, a verified
  -- tenancy). Unverified reviews are a defamation and manipulation surface.
  verified_basis text NOT NULL CHECK (verified_basis IN ('completed_booking','verified_tenancy')),
  basis_id      uuid NOT NULL,
  status        text NOT NULL DEFAULT 'published'
                CHECK (status IN ('published','hidden','removed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reviews_one_per_basis_idx ON reviews(author_id, verified_basis, basis_id);
CREATE INDEX reviews_subject_idx ON reviews(subject_type, subject_id) WHERE status = 'published';
