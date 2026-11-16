-- Per-account balance tracking: until now the balance engine decided purely
-- by account type — other_asset / other_liability balances were their latest
-- valuation and transactions on them were ignored. That fits property and
-- investments but not loans, which are tracked by lending/repayment
-- transactions. Accounts now carry their own mode; the type only supplies
-- the default (and depository / credit_card are always transaction-tracked).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance_tracking text NOT NULL DEFAULT 'valuation';

UPDATE accounts
SET balance_tracking = 'transactions'
WHERE type IN ('depository', 'credit_card');
