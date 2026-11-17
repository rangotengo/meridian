-- Goals / sinking funds: a goal has a target, an optional deadline and
-- at most one link (an account or a category). Progress is computed from
-- live ledger data, never stored, so the table carries only the inputs:
-- the starting balance captured when an account-linked goal is created.
-- The link is created exactly-one by the application, but the CHECK allows
-- both NULL: the foreign keys are ON DELETE SET NULL, so deleting a linked
-- account/category leaves the goal unlinked (progress unknown) instead of
-- failing the delete. A goal with no link is the link-removed state.
CREATE TABLE IF NOT EXISTS goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  target_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  deadline date,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  starting_balance_minor bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goals_target_minor_check CHECK (target_minor > 0),
  CONSTRAINT goals_status_check CHECK (status IN ('active', 'achieved', 'archived')),
  CONSTRAINT goals_at_most_one_link_check CHECK (
    NOT (account_id IS NOT NULL AND category_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS goals_family_idx ON goals(family_id);
CREATE INDEX IF NOT EXISTS goals_family_status_idx ON goals(family_id, status);
