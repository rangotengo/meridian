import { mcpConfig } from "@/lib/env";
import { authorizationServerMetadata } from "@/server/mcp/metadata";

/** RFC 8414 authorization-server metadata. */
export function GET(): Response {
  const config = mcpConfig();
  if (!config) return new Response("Not Found", { status: 404 });
  return Response.json(authorizationServerMetadata(config));
}
