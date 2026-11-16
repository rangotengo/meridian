-- SSIS insight: bind stored datasets and refresh commits to the configured
-- holder. config_generation is bumped whenever the BO account number in
-- ssis_insight_state changes; a live refresh captures the generation it
-- fetched for and re-checks it inside its commit transaction, so a refresh
-- started for one holder can never repopulate the insight after the
-- configuration switched to another holder.
ALTER TABLE ssis_insight_state
  ADD COLUMN config_generation integer NOT NULL DEFAULT 0;
