-- MCP read-only AI-agent access: purpose-built OAuth 2.1 authorization
-- server tables. DCR clients (oauth_clients), durable per-connection grants
-- bound to user + client + ONE household (oauth_grants), single-use
-- authorization codes, and opaque hash-stored tokens with rotation chains.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id text PRIMARY KEY,
  client_name text NOT NULL,
  redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  secret_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  client_name text NOT NULL,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  account_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_grants_user_idx ON oauth_grants (user_id);
CREATE INDEX IF NOT EXISTS oauth_grants_client_idx ON oauth_grants (client_id);
CREATE INDEX IF NOT EXISTS oauth_grants_family_idx ON oauth_grants (family_id);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  code_challenge text NOT NULL,
  used_at timestamptz,
  issued_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_authorization_codes_hash_unique ON oauth_authorization_codes (code_hash);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_grant_idx ON oauth_authorization_codes (grant_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  code_id uuid REFERENCES oauth_authorization_codes(id) ON DELETE SET NULL,
  kind text NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by_id uuid,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_hash_unique ON oauth_tokens (token_hash);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens (grant_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_code_idx ON oauth_tokens (code_id);
