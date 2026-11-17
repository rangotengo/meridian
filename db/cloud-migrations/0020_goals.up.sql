-- Goals / sinking funds (cloud/SQLite mirror of Postgres migration 0020).
CREATE TABLE IF NOT EXISTS goals (
  id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  target_minor integer NOT NULL,
  currency text NOT NULL,
  deadline text,
  account_id text REFERENCES accounts(id) ON DELETE SET NULL,
  category_id text REFERENCES categories(id) ON DELETE SET NULL,
  starting_balance_minor integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (target_minor > 0),
  CHECK (status IN ('active', 'achieved', 'archived')),
  CHECK (NOT (account_id IS NOT NULL AND category_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS goals_family_idx ON goals(family_id);
CREATE INDEX IF NOT EXISTS goals_family_status_idx ON goals(family_id, status);
