-- Cost-basis provenance for manual portfolio holdings: average_cost_minor
-- is a per-share average that only describes part of a position when shares
-- were acquired without a recorded cost (e.g. a buy into a position whose
-- cost was unknown). average_cost_quantity is the decimal-string quantity
-- (up to 6dp, same contract as quantity) that the average applies to; the
-- remainder of the position has unknown cost and summaries report it as
-- partial. Backfill: a position with a recorded average cost was written
-- under the rule that the average covered the whole position, so its known
-- quantity is its full quantity; positions without a cost know nothing.
ALTER TABLE portfolio_holdings
  ADD COLUMN IF NOT EXISTS average_cost_quantity text NOT NULL DEFAULT '0';

UPDATE portfolio_holdings
SET average_cost_quantity = quantity
WHERE average_cost_minor IS NOT NULL;
