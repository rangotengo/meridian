-- SSIS insight: persist per-dataset fetch coverage on the insight state.
-- A refresh fetches purchases, statement and NAV independently and can
-- partially succeed; until now only a single last_fetched_at was kept,
-- so a later reader (the MCP tools) could not distinguish "the purchase
-- fetch failed" from "the holder genuinely has no purchases" — a failed
-- holder fetch surfaced as a fresh, complete-looking zero position.
-- Each dataset now records its last known outcome ('ok' | 'failed';
-- NULL = never established) and the timestamp of its last SUCCESSFUL
-- fetch. A failed refresh updates coverage but never the timestamp, so
-- stored rows from an older success stay visibly stale.
ALTER TABLE ssis_insight_state ADD COLUMN IF NOT EXISTS purchases_coverage text;
ALTER TABLE ssis_insight_state ADD COLUMN IF NOT EXISTS purchases_fetched_at timestamp with time zone;
ALTER TABLE ssis_insight_state ADD COLUMN IF NOT EXISTS statement_coverage text;
ALTER TABLE ssis_insight_state ADD COLUMN IF NOT EXISTS statement_fetched_at timestamp with time zone;
ALTER TABLE ssis_insight_state ADD COLUMN IF NOT EXISTS nav_coverage text;
ALTER TABLE ssis_insight_state ADD COLUMN IF NOT EXISTS nav_fetched_at timestamp with time zone;
