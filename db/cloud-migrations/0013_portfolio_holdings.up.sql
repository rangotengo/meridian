-- Manual portfolio holdings (cloud/SQLite mirror of Postgres migration
-- 0012): user-entered stock positions on other_asset accounts. While an
-- account has holdings, its balance is managed by them via a daily
-- "holdings" valuation entry, and manual valuations are rejected.
CREATE TABLE IF NOT EXISTS portfolio_holdings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ticker text NOT NULL,
  company_name text,
  quantity text NOT NULL,
  average_cost_minor INTEGER,
  current_price_minor INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (account_id, ticker)
);

CREATE INDEX IF NOT EXISTS portfolio_holdings_account_idx ON portfolio_holdings (account_id);
