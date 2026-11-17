-- Loan interest rate: annual rate in basis points (1200 = 12.00%), NULL
-- when unknown. The debt payoff planner reads it; a NULL rate plans
-- with zero interest and says so.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS interest_rate_bps integer;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_interest_rate_bps_check'
  ) THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_interest_rate_bps_check
      CHECK (interest_rate_bps IS NULL OR (interest_rate_bps >= 0 AND interest_rate_bps <= 100000));
  END IF;
END $$;
