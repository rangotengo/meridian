-- SSIS insight (cloud/SQLite mirror of Postgres migration 0012): a
-- self-contained, read-only snapshot of the owner's Siddhartha Systematic
-- Investment Scheme, stored apart from accounts/entries/balances. Only
-- whitelisted upstream fields are persisted — no PII beyond the holder name
-- and the user-entered BO account number in ssis_insight_state.
CREATE TABLE IF NOT EXISTS ssis_purchases (
  id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  request_no text NOT NULL,
  apply_date text NOT NULL,
  units text NOT NULL,
  amount_minor integer NOT NULL,
  status text NOT NULL DEFAULT '',
  purchase_nav_minor integer,
  nav_date text,
  scheme_name text,
  is_sip integer NOT NULL DEFAULT 0,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ssis_purchases_family_request_unique ON ssis_purchases (family_id, request_no);
CREATE INDEX IF NOT EXISTS ssis_purchases_family_idx ON ssis_purchases (family_id);

CREATE TABLE IF NOT EXISTS ssis_statement_entries (
  id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  trans_no text NOT NULL,
  installment_date text NOT NULL,
  due_date text,
  action_date text,
  amount_cr_minor integer NOT NULL DEFAULT 0,
  amount_dr_minor integer NOT NULL DEFAULT 0,
  units text,
  applied_nav_minor integer,
  payment text,
  other_charges_minor integer NOT NULL DEFAULT 0,
  sebon_fee_minor integer NOT NULL DEFAULT 0,
  sip_reg_no text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ssis_statement_family_trans_unique ON ssis_statement_entries (family_id, trans_no);
CREATE INDEX IF NOT EXISTS ssis_statement_family_idx ON ssis_statement_entries (family_id);

CREATE TABLE IF NOT EXISTS ssis_nav_history (
  id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  eng_date text NOT NULL,
  nep_date text NOT NULL,
  nav_minor integer NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ssis_nav_history_family_date_unique ON ssis_nav_history (family_id, eng_date);
CREATE INDEX IF NOT EXISTS ssis_nav_history_family_idx ON ssis_nav_history (family_id);

CREATE TABLE IF NOT EXISTS ssis_insight_state (
  family_id text PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
  holder_name text,
  bo_account_no text,
  latest_nav_minor integer,
  latest_nav_date text,
  last_fetched_at text,
  last_source text,
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
