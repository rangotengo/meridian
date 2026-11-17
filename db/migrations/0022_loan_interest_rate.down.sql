ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_interest_rate_bps_check;
ALTER TABLE accounts DROP COLUMN IF EXISTS interest_rate_bps;
