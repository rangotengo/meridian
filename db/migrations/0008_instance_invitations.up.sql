CREATE TABLE IF NOT EXISTS instance_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instance_invitations_email_idx ON instance_invitations (email);
CREATE UNIQUE INDEX IF NOT EXISTS instance_invitations_token_hash_unique ON instance_invitations (token_hash);
