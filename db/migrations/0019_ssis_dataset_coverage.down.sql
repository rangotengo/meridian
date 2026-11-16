ALTER TABLE ssis_insight_state DROP COLUMN IF EXISTS nav_fetched_at;
ALTER TABLE ssis_insight_state DROP COLUMN IF EXISTS nav_coverage;
ALTER TABLE ssis_insight_state DROP COLUMN IF EXISTS statement_fetched_at;
ALTER TABLE ssis_insight_state DROP COLUMN IF EXISTS statement_coverage;
ALTER TABLE ssis_insight_state DROP COLUMN IF EXISTS purchases_fetched_at;
ALTER TABLE ssis_insight_state DROP COLUMN IF EXISTS purchases_coverage;
