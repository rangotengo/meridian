/**
 * Dynamic Client Registration (RFC 7591). Public, but rate-limited and
 * restricted by the DCR redirect-URI policy in the domain service
 * (first-party AI client callbacks + loopback only for this release).
 */
import { mcpConfig } from "@/lib/env";
import { DomainError } from "@/lib/errors";
import { getDb } from "@/server/db/client";
import { OAuthError, registerOAuthClient } from "@/server/domain/oauth";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { oauthErrorResponse } from "@/server/mcp/metadata";

/** Best-effort client key for the registration rate limit. Behind the
 * production proxy these headers are set by the edge; the limit is an
 * anti-abuse brake, not an authentication control. */
function clientKey(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export async function POST(request: Request): Promise<Response> {
  const config = mcpConfig();
  if (!config) return new Response("Not Found", { status: 404 });
  try {
    const exec = await getDb();
    try {
      await consumeRateLimit(exec, `oauth-register:${clientKey(request)}`, 10, 3600);
    } catch (error) {
      if (error instanceof DomainError) {
        return Response.json(
          {
            error: "temporarily_unavailable",
            error_description: "Registration rate limit reached. Try again later."
          },
          { status: 429 }
        );
      }
      throw error;
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new OAuthError("invalid_client_metadata", "Request body must be JSON.");
    }
    const input = (body ?? {}) as Record<string, unknown>;
    if (
      Array.isArray(input.response_types) &&
      !(input.response_types.length === 1 && input.response_types[0] === "code")
    ) {
      throw new OAuthError("invalid_client_metadata", 'Only response_types=["code"] is supported.');
    }
    const redirectUris = Array.isArray(input.redirect_uris)
      ? input.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    const { client, clientSecret } = await registerOAuthClient(exec, {
      clientName: typeof input.client_name === "string" ? input.client_name : undefined,
      redirectUris,
      tokenEndpointAuthMethod:
        typeof input.token_endpoint_auth_method === "string"
          ? input.token_endpoint_auth_method
          : undefined
    });

    return Response.json(
      {
        client_id: client.id,
        ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "finance:read transactions:read transactions:notes offline_access"
      },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof OAuthError) return oauthErrorResponse(error);
    throw error;
  }
}
