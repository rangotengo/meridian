-- Server-side authorization-request records for the MCP OAuth consent
-- flow (cloud/SQLite mirror of Postgres migration 0010).
CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id text NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  client_id text NOT NULL,
  client_name text NOT NULL,
  redirect_uri text NOT NULL,
  scopes text NOT NULL DEFAULT '[]',
  resource text NOT NULL,
  code_challenge text NOT NULL,
  state text,
  csrf_token_hash text NOT NULL,
  expires_at text NOT NULL,
  consumed_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS oauth_authorization_requests_user_idx ON oauth_authorization_requests (user_id);
