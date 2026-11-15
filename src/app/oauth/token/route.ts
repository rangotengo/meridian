/**
 * OAuth 2.1 token endpoint: authorization_code exchange (PKCE S256,
 * single-use codes, replay → family revocation) and refresh_token
 * rotation with reuse detection. Form-encoded only, per RFC 6749.
 */
import { mcpConfig } from "@/lib/env";
import { getDb } from "@/server/db/client";
import {
  OAuthError,
  authenticateOAuthClient,
  exchangeAuthorizationCode,
  refreshOAuthToken,
  type TokenSuccess
} from "@/server/domain/oauth";
import { oauthErrorResponse } from "@/server/mcp/metadata";

function parseBasicAuth(header: string | null): { clientId: string; clientSecret: string } | null {
  if (!header?.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    // RFC 6749 §2.3.1: both halves are form-encoded inside the payload.
    return {
      clientId: decodeURIComponent(decoded.slice(0, sep)),
      clientSecret: decodeURIComponent(decoded.slice(sep + 1))
    };
  } catch {
    return null;
  }
}

function tokenResponse(result: TokenSuccess): Response {
  return Response.json(
    {
      access_token: result.accessToken,
      token_type: result.tokenType,
      expires_in: result.expiresIn,
      ...(result.refreshToken ? { refresh_token: result.refreshToken } : {}),
      scope: result.scope
    },
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } }
  );
}

export async function POST(request: Request): Promise<Response> {
  const config = mcpConfig();
  if (!config) return new Response("Not Found", { status: 404 });
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      throw new OAuthError(
        "invalid_request",
        "Token requests must be application/x-www-form-urlencoded."
      );
    }
    const form = await request.formData();
    const basic = parseBasicAuth(request.headers.get("authorization"));
    const exec = await getDb();
    const client = await authenticateOAuthClient(
      exec,
      {
        clientId: basic?.clientId ?? (form.get("client_id") as string | null),
        clientSecret: basic?.clientSecret ?? (form.get("client_secret") as string | null),
        clientAssertion: form.get("client_assertion") as string | null,
        clientAssertionType: form.get("client_assertion_type") as string | null
      },
      config
    );

    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      return tokenResponse(
        await exchangeAuthorizationCode(
          exec,
          {
            code: form.get("code") as string | null,
            redirectUri: form.get("redirect_uri") as string | null,
            codeVerifier: form.get("code_verifier") as string | null,
            resource: form.get("resource") as string | null
          },
          client,
          config
        )
      );
    }
    if (grantType === "refresh_token") {
      return tokenResponse(
        await refreshOAuthToken(
          exec,
          {
            refreshToken: form.get("refresh_token") as string | null,
            resource: form.get("resource") as string | null
          },
          client,
          config
        )
      );
    }
    throw new OAuthError("unsupported_grant_type", "Unsupported grant_type.");
  } catch (error) {
    if (error instanceof OAuthError) return oauthErrorResponse(error);
    throw error;
  }
}
