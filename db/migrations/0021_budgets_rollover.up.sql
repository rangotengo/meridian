-- Budget rollover: a budget can carry last month's unspent amount into
-- this month's effective limit. Only the flag is stored; the credit is
-- computed from last month's end-of-month limit minus last month's
-- spending (see src/server/domain/budgets.ts).
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS rollover boolean NOT NULL DEFAULT false;
