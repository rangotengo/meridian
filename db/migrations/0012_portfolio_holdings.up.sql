-- Manual portfolio holdings: user-entered stock positions on
-- valuation-driven (other_asset) accounts, for portfolios that can never
-- arrive via a MeroShare sync. While an account has holdings, its balance
-- is managed by them (a daily "holdings" valuation entry written by the
-- domain) and manual valuations are rejected. Quantity is stored as a
-- decimal string (up to 6dp) so the Postgres and cloud SQLite shapes stay
-- identical; per-share prices are minor units.
CREATE TABLE IF NOT EXISTS portfolio_holdings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ticker text NOT NULL,
  company_name text,
  quantity text NOT NULL,
  average_cost_minor bigint,
  current_price_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ticker)
);

CREATE INDEX IF NOT EXISTS portfolio_holdings_account_idx ON portfolio_holdings (account_id);
