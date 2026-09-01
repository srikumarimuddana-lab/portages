-- Reverses 016.
--
-- Dropping the ledger loses spend history. Nothing depends on it: the AI
-- features degrade to running without a recorder, exactly as they do when the
-- ledger is not wired in, so a rollback does not take AI down with it.

DROP TRIGGER IF EXISTS ai_calls_immutable ON ai_calls;
DROP TABLE IF EXISTS ai_calls;
