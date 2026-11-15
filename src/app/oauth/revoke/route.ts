/**
 * RFC 7009 token revocation. Always 200 for well-formed requests —
 * the endpoint never confirms whether a token existed.
 */
import { mcpConfig } from "@/lib/env";
import { getDb } from "@/server/db/client";
import { revokeOAuthToken } from "@/server/domain/oauth";

export async function POST(request: Request): Promise<Response> {
  const config = mcpConfig();
  if (!config) return new Response("Not Found", { status: 404 });
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const exec = await getDb();
    await revokeOAuthToken(exec, {
      token: form.get("token") as string | null,
      clientId: form.get("client_id") as string | null
    });
  }
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
