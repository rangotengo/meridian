/**
 * Discovery documents (RFC 9728 protected-resource metadata, RFC 8414
 * authorization-server metadata) and OAuth error serialization.
 *
 * Everything here is derived from CONFIG (the canonical resource URL and
 * issuer URL) — never from request Host headers — so discovery always
 * names the one exact resource identifier clients must use as audience.
 */
import type { McpConfig } from "@/lib/env";
import { MCP_ALL_SCOPES, MCP_READ_SCOPES } from "./scopes";
import { OAuthError } from "../domain/oauth";

export function protectedResourceMetadata(config: McpConfig) {
  return {
    resource: config.resourceUrl,
    authorization_servers: [config.issuerUrl],
    // offline_access is deliberately NOT advertised here (2025-11-25 MCP
    // authorization profile); it lives only in AS metadata.
    scopes_supported: [...MCP_READ_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Meridian",
    resource_documentation: "https://github.com/rangotengo/meridian"
  };
}

export function authorizationServerMetadata(config: McpConfig) {
  const issuer = config.issuerUrl;
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
      "private_key_jwt"
    ],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    scopes_supported: [...MCP_ALL_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true
  };
}

export function oauthErrorResponse(error: OAuthError): Response {
  return Response.json(
    { error: error.error, error_description: error.message },
    {
      status: error.status,
      headers: {
        "Cache-Control": "no-store",
        ...(error.status === 401 ? { "WWW-Authenticate": 'Bearer realm="oauth"' } : {})
      }
    }
  );
}

/** The RFC 9728 §5.1 challenge the /mcp endpoint returns on 401. */
export function mcpChallengeHeader(config: McpConfig): string {
  const resourceOrigin = new URL(config.resourceUrl).origin;
  return `Bearer resource_metadata="${resourceOrigin}/.well-known/oauth-protected-resource/mcp", scope="${MCP_READ_SCOPES.join(" ")}"`;
}
