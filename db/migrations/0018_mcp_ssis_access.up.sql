-- MCP SSIS access: an explicit per-connection permission on oauth_grants.
-- SSIS is a separate household-wide insight dataset, so finance:read must
-- not silently cover it: ssis_access defaults to false for every existing
-- and future grant, and the connection owner opts in per connection (on
-- the consent page or later in Connected AI agents). Tool handlers check
-- the flag on the live grant row, so toggling it takes effect on the very
-- next call without reissuing tokens.
ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS ssis_access boolean NOT NULL DEFAULT false;
