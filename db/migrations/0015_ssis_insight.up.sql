-- SSIS insight: a self-contained, read-only view of the owner's Siddhartha
-- Systematic Investment Scheme (Siddhartha Capital, scheme_code 001). These
-- tables are deliberately separate from accounts/entries/balances: the data
-- is an external snapshot, never ledger data. Only whitelisted fields from
-- the upstream payload are stored — no citizenship/PAN/bank/BO identifiers
-- or contact details ever land here (the BO account number lives only in
-- ssis_insight_state, entered by the user for server-side refresh calls).
CREATE TABLE ssis_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  request_no text NOT NULL,
  apply_date date NOT NULL,
  units text NOT NULL,
  amount_minor bigint NOT NULL,
  status text NOT NULL DEFAULT '',
  purchase_nav_minor bigint,
  nav_date date,
  scheme_name text,
  is_sip boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ssis_purchases_family_request_unique ON ssis_purchases (family_id, request_no);
CREATE INDEX ssis_purchases_family_idx ON ssis_purchases (family_id);

CREATE TABLE ssis_statement_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  trans_no text NOT NULL,
  installment_date date NOT NULL,
  due_date date,
  action_date date,
  amount_cr_minor bigint NOT NULL DEFAULT 0,
  amount_dr_minor bigint NOT NULL DEFAULT 0,
  units text,
  applied_nav_minor bigint,
  payment text,
  other_charges_minor bigint NOT NULL DEFAULT 0,
  sebon_fee_minor bigint NOT NULL DEFAULT 0,
  sip_reg_no text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ssis_statement_family_trans_unique ON ssis_statement_entries (family_id, trans_no);
CREATE INDEX ssis_statement_family_idx ON ssis_statement_entries (family_id);

CREATE TABLE ssis_nav_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  eng_date date NOT NULL,
  nep_date text NOT NULL,
  nav_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ssis_nav_history_family_date_unique ON ssis_nav_history (family_id, eng_date);
CREATE INDEX ssis_nav_history_family_idx ON ssis_nav_history (family_id);

CREATE TABLE ssis_insight_state (
  family_id uuid PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
  holder_name text,
  bo_account_no text,
  latest_nav_minor bigint,
  latest_nav_date date,
  last_fetched_at timestamptz,
  last_source text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
