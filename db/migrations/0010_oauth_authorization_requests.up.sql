-- Server-side authorization-request records for the MCP OAuth consent
-- flow: consent renders from the record and approval consumes it once,
-- binding the decision to the exact request (client, redirect_uri,
-- scopes, resource, code challenge, household) and to the session.
CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  client_id text NOT NULL,
  client_name text NOT NULL,
  redirect_uri text NOT NULL,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  resource text NOT NULL,
  code_challenge text NOT NULL,
  state text,
  csrf_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_authorization_requests_user_idx ON oauth_authorization_requests (user_id);
