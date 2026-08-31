-- 017: make user reports usable.
--
-- The `reports` table has existed since 006 with no writer and no reader, so
-- until now the moderation queue held only what the heuristics caught. A
-- regex does not know that the flat in the photos is the reporter's own
-- living room; a person does. This adds the two constraints that turn the
-- table into something a queue can be built on.

-- ── one open report per person per subject ─────────────────────────────────
--
-- The distinction this draws is the whole point of the index.
--
-- TEN PEOPLE reporting one listing is a much stronger signal than one person
-- reporting it — that is corroboration, and the queue should weight it up.
-- ONE PERSON reporting the same listing ten times is not a stronger signal at
-- all; it is one opinion, or someone trying to bury a competitor.
--
-- Without this, both look identical to a count(*) and the queue cannot tell
-- corroboration from a grudge. Partial on `status = 'open'` so that a
-- resolved report does not stop the same person reporting a genuine
-- recurrence later.
CREATE UNIQUE INDEX reports_one_open_per_reporter_idx
  ON reports (reporter_id, subject_type, subject_id)
  WHERE status = 'open' AND reporter_id IS NOT NULL;

-- ── counting reports against a subject ─────────────────────────────────────
--
-- `reports_open_idx` orders the queue by severity; this serves the other
-- question, asked once per incoming report: how many people have already
-- said this about this listing? Without it that count is a sequential scan on
-- the write path.
CREATE INDEX reports_subject_idx
  ON reports (subject_type, subject_id, status);

-- ── who is doing the reporting ─────────────────────────────────────────────
--
-- One account reporting forty listings in an evening is the abuse pattern
-- here, and it is invisible when you can only look up by subject. Partial:
-- anonymous reports are not supported today (see modules/trust/reports.ts for
-- why), and the column is nullable only because a reporter's account may be
-- deleted afterwards.
CREATE INDEX reports_reporter_idx
  ON reports (reporter_id, created_at DESC)
  WHERE reporter_id IS NOT NULL;
