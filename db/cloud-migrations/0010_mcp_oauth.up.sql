-- MCP read-only AI-agent access: purpose-built OAuth 2.1 authorization
-- server tables (cloud/SQLite mirror of Postgres migration 0009).
CREATE TABLE IF NOT EXISTS oauth_clients (
  id text PRIMARY KEY,
  client_name text NOT NULL,
  redirect_uris text NOT NULL DEFAULT '[]',
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  secret_hash text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id text NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  client_name text NOT NULL,
  scopes text NOT NULL DEFAULT '[]',
  account_ids text NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'active',
  expires_at text NOT NULL,
  last_used_at text,
  revoked_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS oauth_grants_user_idx ON oauth_grants (user_id);
CREATE INDEX IF NOT EXISTS oauth_grants_client_idx ON oauth_grants (client_id);
CREATE INDEX IF NOT EXISTS oauth_grants_family_idx ON oauth_grants (family_id);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id text PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  grant_id text NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  code_challenge text NOT NULL,
  used_at text,
  issued_at text,
  expires_at text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_authorization_codes_hash_unique ON oauth_authorization_codes (code_hash);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_grant_idx ON oauth_authorization_codes (grant_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  grant_id text NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  code_id text REFERENCES oauth_authorization_codes(id) ON DELETE SET NULL,
  kind text NOT NULL,
  resource text NOT NULL,
  expires_at text NOT NULL,
  revoked_at text,
  replaced_by_id text,
  last_used_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_hash_unique ON oauth_tokens (token_hash);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens (grant_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_code_idx ON oauth_tokens (code_id);
