-- MCP SSIS access (cloud/SQLite mirror of Postgres migration 0018): an
-- explicit per-connection permission on oauth_grants, default false.
-- SSIS is a separate household-wide insight dataset that finance:read
-- must not silently cover; tool handlers check the flag on the live
-- grant row, so toggling it takes effect on the very next call.
ALTER TABLE oauth_grants ADD COLUMN ssis_access integer NOT NULL DEFAULT 0;
