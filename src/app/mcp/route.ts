/**
 * The MCP endpoint. One route file serves both runtimes (Node and
 * OpenNext/Workers) — the transport spike proved the SDK's Web Standard
 * handler behaves identically on each.
 *
 * Request pipeline: config gate (404 when MCP is not configured) →
 * config-pinned host/origin guard → opaque bearer verification with
 * per-call re-resolution of grant, user, and bound household
 * (resolveMcpAccess) → the SDK handler.
 */
import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse
} from "@modelcontextprotocol/server";
import { mcpConfig } from "@/lib/env";
import { getDb } from "@/server/db/client";
import { resolveMcpAccess } from "@/server/domain/oauth";
import { handleMcpRequest } from "@/server/mcp/server";
import { mcpChallengeHeader } from "@/server/mcp/metadata";

async function handle(request: Request): Promise<Response> {
  const config = mcpConfig();
  if (!config) return new Response("Not Found", { status: 404 });

  // Host/origin allowlists are pinned from CONFIG (canonical resource +
  // issuer hostnames, plus loopback for local development) — never
  // derived from the incoming Host header. Under `wrangler dev` the app
  // sees the production hostname even for local requests, so a
  // loopback-only list would reject all local Workers traffic.
  const allowedHostnames = [
    ...new Set([
      ...localhostAllowedHostnames(),
      new URL(config.resourceUrl).hostname,
      new URL(config.issuerUrl).hostname
    ])
  ];
  const hostGuard = hostHeaderValidationResponse(request, allowedHostnames);
  if (hostGuard) return hostGuard;
  const allowedOriginHostnames = [...new Set([...localhostAllowedOrigins(), ...allowedHostnames])];
  const originGuard = originValidationResponse(request, allowedOriginHostnames);
  if (originGuard) return originGuard;

  const header = request.headers.get("authorization");
  const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7) : null;
  const exec = await getDb();
  const access = token ? await resolveMcpAccess(exec, token, config) : null;
  if (!access) {
    return Response.json(
      { error: "invalid_token", error_description: "A valid MCP access token is required." },
      { status: 401, headers: { "WWW-Authenticate": mcpChallengeHeader(config) } }
    );
  }
  return handleMcpRequest(request, { exec, access, config });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
