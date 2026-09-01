-- 016: the AI call ledger.
--
-- Every model call, recorded. The Vercel AI Gateway dashboard already knows
-- what was spent; this table exists for the three questions it cannot answer:
--
--   * WHICH SUBJECT. "Why was this listing auto-flagged?" needs the call that
--     decided it, joined to the listing. A dashboard aggregates by day and
--     model, not by row.
--   * WHICH ACTOR. One account running a thousand searches looks identical to
--     a thousand accounts running one, until you can group by actor.
--   * WHAT FAILED. Refusals and timeouts are billed and produce nothing. A
--     rising refusal rate is a prompt regression; a rising timeout rate is a
--     provider problem. Both are invisible in a spend total.
--
-- WHAT IS DELIBERATELY NOT HERE: the prompt, the completion, the message
-- body, the listing text. Not one character of content.
--
-- That is the whole design constraint. A ledger holding every message body
-- would be a SECOND COPY of the most sensitive data on the site, living
-- outside the retention rules that govern `messages` and outside the access
-- control that governs `threads` — readable by anyone who can read this
-- table, and still there long after the message it copied was deleted.
-- Token counts answer every question above; the content answers none of them.
--
-- Debugging a bad model reply therefore needs the subject row, which is
-- exactly the access check we already enforce.

CREATE TABLE ai_calls (
  id            bigserial PRIMARY KEY,

  task          text NOT NULL
                CHECK (task IN ('chat_search', 'listing_builder', 'moderation')),
  provider      text NOT NULL,
  -- The model that SERVED the turn, which is not always the one requested:
  -- the Gateway fails over, and a bill nobody can attribute is a bill nobody
  -- can reduce.
  model         text NOT NULL,

  input_tokens      integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens     integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens integer CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),

  -- 'refused' and 'error' are separate on purpose. A refusal is a successful,
  -- billed call that produced nothing; an error produced nothing and may not
  -- have been billed. Collapsing them hides a prompt regression inside what
  -- looks like provider flakiness.
  outcome       text NOT NULL
                CHECK (outcome IN ('ok', 'refused', 'unparseable', 'error', 'timeout')),
  latency_ms    integer CHECK (latency_ms IS NULL OR latency_ms >= 0),

  -- No foreign keys, matching audit_log and for the same reason: the record
  -- of what was spent on someone's behalf must outlive the account, and a
  -- cascade would erase the evidence at the moment it matters.
  actor_id      uuid,
  subject_type  text CHECK (subject_type IS NULL OR subject_type IN ('listing', 'message', 'thread')),
  subject_id    text,

  at            timestamptz NOT NULL DEFAULT now()
);

-- The three reads this table exists for.
CREATE INDEX ai_calls_recent_idx  ON ai_calls(at DESC);
CREATE INDEX ai_calls_task_idx    ON ai_calls(task, at DESC);
CREATE INDEX ai_calls_actor_idx   ON ai_calls(actor_id, at DESC) WHERE actor_id IS NOT NULL;
-- Partial, because "what went wrong" is a small slice of a large table and
-- the whole point is to find it without scanning the successful calls.
CREATE INDEX ai_calls_failed_idx  ON ai_calls(task, at DESC) WHERE outcome <> 'ok';

-- Immutable, but NOT undeletable — and the difference from audit_log is
-- deliberate rather than an oversight.
--
-- audit_log blocks UPDATE and DELETE because the party being audited must not
-- be able to rewrite or clear it, and its volume is a handful of staff
-- decisions a week. This table takes a row per model call, which is orders of
-- magnitude more, and a table that can never be pruned grows without bound.
--
-- So: a row's contents can never be changed (no quietly relabelling an
-- expensive call as a cheap one), but old rows can be swept on the same
-- retention schedule as everything else. The trigger fires on UPDATE only.
CREATE TRIGGER ai_calls_immutable BEFORE UPDATE
  ON ai_calls FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
