DROP TABLE IF EXISTS oauth_assertion_claims;
ALTER TABLE oauth_authorization_codes DROP COLUMN IF EXISTS invalidated_at;
