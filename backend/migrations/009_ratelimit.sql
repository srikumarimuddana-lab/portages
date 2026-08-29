-- 009: durable rate limiting.
--
-- The in-process limiter in src/lib/ratelimit.ts is correct for a single
-- process, but Vercel runs many warm instances concurrently — each with its
-- own counters. The effective limit becomes (max x instances), which means
-- login throttling can be bypassed simply by spreading requests. Shared
-- state is the only correct answer.
--
-- A fixed window is used deliberately: it needs one atomic upsert per check,
-- versus a sliding window's read-modify-write. At Portage's volume the burst
-- imprecision at a window boundary is irrelevant next to the cost of a race.

CREATE TABLE rate_limit_buckets (
  -- bucket = limiter name + pseudonymized subject (never a raw IP)
  bucket      text PRIMARY KEY,
  count       integer NOT NULL DEFAULT 0,
  reset_at    timestamptz NOT NULL
);

-- Lets the sweeper find expired rows without scanning the whole table.
CREATE INDEX rate_limit_reset_idx ON rate_limit_buckets(reset_at);

-- Atomically increments a bucket and reports the verdict.
-- Returns the post-increment count and the window expiry, so the caller can
-- compute both `allowed` and `Retry-After` from one round trip.
--
-- The ON CONFLICT branch resets the window in the same statement when the
-- previous one has expired, so no separate cleanup is needed on the hot path.
CREATE OR REPLACE FUNCTION rate_limit_hit(
  p_bucket   text,
  p_window   interval,
  OUT o_count integer,
  OUT o_reset timestamptz
) LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO rate_limit_buckets AS b (bucket, count, reset_at)
       VALUES (p_bucket, 1, now() + p_window)
  ON CONFLICT (bucket) DO UPDATE
     SET count    = CASE WHEN b.reset_at <= now() THEN 1 ELSE b.count + 1 END,
         reset_at = CASE WHEN b.reset_at <= now() THEN now() + p_window ELSE b.reset_at END
  RETURNING b.count, b.reset_at INTO o_count, o_reset;
END;
$$;
