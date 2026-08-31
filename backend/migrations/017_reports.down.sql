-- Reverses 017.
--
-- Indexes only — the `reports` table itself belongs to 006 and stays. A
-- rollback loses the duplicate-report guard, so the service's own check
-- becomes the only one; that check exists anyway and is not weakened here.

DROP INDEX IF EXISTS reports_reporter_idx;
DROP INDEX IF EXISTS reports_subject_idx;
DROP INDEX IF EXISTS reports_one_open_per_reporter_idx;
