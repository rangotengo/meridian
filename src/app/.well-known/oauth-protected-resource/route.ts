import { mcpConfig } from "@/lib/env";
import { protectedResourceMetadata } from "@/server/mcp/metadata";

/** RFC 9728 protected-resource metadata (root variant). */
export function GET(): Response {
  const config = mcpConfig();
  if (!config) return new Response("Not Found", { status: 404 });
  return Response.json(protectedResourceMetadata(config));
}
