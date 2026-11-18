-- Loan interest rate (cloud/SQLite mirror of Postgres migration 0022).
ALTER TABLE accounts ADD COLUMN interest_rate_bps integer;
