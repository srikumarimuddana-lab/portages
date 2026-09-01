-- The consent invariant, against the real schema.
--
-- The TypeScript tests prove SavedSearchService grants and revokes correctly.
-- These prove the DATABASE would refuse the forbidden state even if it did
-- not — which is the point of having the constraint as well as the code. An
-- alert is a commercial electronic message under CASL, and the penalty for
-- sending one without consent is larger than this business.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL client_min_messages = warning;

CREATE OR REPLACE FUNCTION assert(cond boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT cond THEN RAISE EXCEPTION 'ASSERTION FAILED: %', msg; END IF;
END;
$$;

INSERT INTO users (id, email, password_hash, email_verified_at)
VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'searcher@example.test', 'x', now());

-- ── 1. an alert cannot be enabled without a consent row ────────────────────

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    INSERT INTO saved_searches (user_id, name, query, alert_enabled, consent_id)
    VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'No consent',
            '{"minBeds":2}'::jsonb, true, NULL);
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised,
    'an alert with no consent row must be refused by alert_requires_consent');
END;
$$;

-- ── 2. the same row is fine once consent exists ────────────────────────────

INSERT INTO consents (id, user_id, kind, channel, method)
VALUES ('cccccccc-1111-4111-8111-111111111111',
        'aaaaaaaa-1111-4111-8111-111111111111',
        'saved_search_alert', 'email', 'express_optin');

INSERT INTO saved_searches (id, user_id, name, query, alert_enabled, consent_id)
VALUES ('dddddddd-1111-4111-8111-111111111111',
        'aaaaaaaa-1111-4111-8111-111111111111', 'With consent',
        '{"minBeds":2}'::jsonb, true, 'cccccccc-1111-4111-8111-111111111111');

-- ── 3. an alert cannot be switched on by an UPDATE either ──────────────────
-- A CHECK constraint applies to every write, which is exactly why it is worth
-- having alongside the service: a code path that only clears consent_id, or
-- only sets the flag, cannot leave the row in the forbidden state.

DO $$
DECLARE raised boolean := false;
BEGIN
  BEGIN
    UPDATE saved_searches SET consent_id = NULL
     WHERE id = 'dddddddd-1111-4111-8111-111111111111';
  EXCEPTION WHEN check_violation THEN raised := true;
  END;
  PERFORM assert(raised,
    'clearing consent while the alert is on must be refused');
END;
$$;

-- ── 4. revoking consent does NOT disable the alert ─────────────────────────
-- The uncomfortable one, and the reason the send path re-checks. The
-- constraint proves a consent row was REFERENCED, not that it is still live:
-- an unsubscribe leaves alert_enabled true pointing at a revoked row, and only
-- the runtime check stops the message.

UPDATE consents SET revoked_at = now()
 WHERE id = 'cccccccc-1111-4111-8111-111111111111';

DO $$
DECLARE still_on boolean;
BEGIN
  SELECT alert_enabled INTO still_on FROM saved_searches
   WHERE id = 'dddddddd-1111-4111-8111-111111111111';
  PERFORM assert(still_on,
    'the constraint alone does not react to a revocation — this is why '
    || 'NotifyService re-checks consent before every send');

  -- And the query that decides who gets email must not treat it as live.
  PERFORM assert(
    NOT EXISTS (
      SELECT 1 FROM saved_searches s
        JOIN consents c ON c.id = s.consent_id
       WHERE s.id = 'dddddddd-1111-4111-8111-111111111111'
         AND c.revoked_at IS NULL),
    'a revoked consent must not read as live');
END;
$$;

-- ── 5. deleting the user takes the saved searches with them ────────────────
-- PIPEDA: an account deletion that leaves standing queries behind, still
-- scheduled to mail an address that no longer has an account, has not deleted
-- the account.

DO $$
DECLARE n integer;
BEGIN
  DELETE FROM users WHERE id = 'aaaaaaaa-1111-4111-8111-111111111111';
  SELECT count(*) INTO n FROM saved_searches
   WHERE user_id = 'aaaaaaaa-1111-4111-8111-111111111111';
  PERFORM assert(n = 0, 'saved searches must cascade with the user, ' || n || ' left');
END;
$$;

ROLLBACK;

\echo 'saved searches SQL contract: all assertions passed'
