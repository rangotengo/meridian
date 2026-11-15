-- Durable token-family invalidation for the MCP OAuth server (PR #13
-- review fix round): replay/reuse handling must survive in-flight
-- issuance, so invalidation is a persistent marker on the family root
-- (the authorization code) that token verification and every issuance
-- path check transactionally — not a sweep of currently-visible rows.
ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;

-- Replay claims for private_key_jwt client assertions (RFC 7523): each
-- (client_id, jti) pair may be claimed exactly once, until the
-- end of its acceptance window (expiry plus clock tolerance). Claiming
-- is an insert against this primary key, so concurrent replays race on
-- the database, not on app state.
CREATE TABLE IF NOT EXISTS oauth_assertion_claims (
  client_id text NOT NULL,
  jti text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, jti)
);

CREATE INDEX IF NOT EXISTS oauth_assertion_claims_expires_idx ON oauth_assertion_claims (expires_at);
