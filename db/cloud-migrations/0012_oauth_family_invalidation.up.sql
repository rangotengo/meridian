-- Durable token-family invalidation + private_key_jwt assertion replay
-- claims (cloud/SQLite mirror of Postgres migration 0011).
ALTER TABLE oauth_authorization_codes ADD COLUMN invalidated_at text;

CREATE TABLE IF NOT EXISTS oauth_assertion_claims (
  client_id text NOT NULL,
  jti text NOT NULL,
  expires_at text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (client_id, jti)
);

CREATE INDEX IF NOT EXISTS oauth_assertion_claims_expires_idx ON oauth_assertion_claims (expires_at);
