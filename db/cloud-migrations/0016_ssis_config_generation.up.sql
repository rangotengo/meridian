-- SSIS insight (cloud/SQLite mirror of Postgres migration 0016):
-- config_generation binds refresh commits to the BO configuration they
-- fetched for; bumped on every BO-number change in ssis_insight_state.
ALTER TABLE ssis_insight_state ADD COLUMN config_generation integer NOT NULL DEFAULT 0;
