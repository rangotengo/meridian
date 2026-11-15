CREATE TABLE IF NOT EXISTS instance_invitations (
  id text PRIMARY KEY,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at text NOT NULL,
  accepted_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS instance_invitations_email_idx ON instance_invitations (email);
CREATE UNIQUE INDEX IF NOT EXISTS instance_invitations_token_hash_unique ON instance_invitations (token_hash);
