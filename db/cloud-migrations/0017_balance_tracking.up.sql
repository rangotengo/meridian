-- Per-account balance tracking (cloud/SQLite mirror of Postgres migration
-- 0017): other_asset / other_liability default to 'valuation'; depository /
-- credit_card are always transaction-tracked.
ALTER TABLE accounts ADD COLUMN balance_tracking text NOT NULL DEFAULT 'valuation';

UPDATE accounts
SET balance_tracking = 'transactions'
WHERE type IN ('depository', 'credit_card');
