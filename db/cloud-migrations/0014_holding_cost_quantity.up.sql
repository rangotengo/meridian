-- Cost-basis provenance for manual portfolio holdings (cloud/SQLite mirror
-- of Postgres migration 0013): average_cost_quantity is the decimal-string
-- quantity that average_cost_minor applies to; the rest of the position has
-- unknown cost. Backfill: a recorded average covered the whole position
-- under the previous write rules, so its known quantity is its quantity.
ALTER TABLE portfolio_holdings
  ADD COLUMN average_cost_quantity text NOT NULL DEFAULT '0';

UPDATE portfolio_holdings
SET average_cost_quantity = quantity
WHERE average_cost_minor IS NOT NULL;
