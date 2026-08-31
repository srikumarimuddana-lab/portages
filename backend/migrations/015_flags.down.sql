-- Reverses 015.
--
-- Dropping the table returns every flag to its registry default, which is
-- "on" for each kill switch. That is the correct direction for a rollback:
-- reverting the flags module must not leave capabilities silently off with
-- nothing left in the system that could turn them back on.

DROP TRIGGER IF EXISTS feature_flags_updated ON feature_flags;
DROP TABLE IF EXISTS feature_flags;
