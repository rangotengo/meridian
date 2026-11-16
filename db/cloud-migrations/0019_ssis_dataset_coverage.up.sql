-- SSIS dataset coverage (cloud/SQLite mirror of Postgres migration
-- 0019): per-dataset fetch outcomes on ssis_insight_state so readers can
-- distinguish a failed holder fetch from a genuinely empty dataset.
-- coverage is 'ok' | 'failed' | NULL (never established); fetched_at is
-- the last SUCCESSFUL fetch of that dataset and is never moved by a
-- failed refresh.
ALTER TABLE ssis_insight_state ADD COLUMN purchases_coverage text;
ALTER TABLE ssis_insight_state ADD COLUMN purchases_fetched_at text;
ALTER TABLE ssis_insight_state ADD COLUMN statement_coverage text;
ALTER TABLE ssis_insight_state ADD COLUMN statement_fetched_at text;
ALTER TABLE ssis_insight_state ADD COLUMN nav_coverage text;
ALTER TABLE ssis_insight_state ADD COLUMN nav_fetched_at text;
