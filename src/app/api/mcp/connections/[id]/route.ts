/**
 * Manage an MCP connection (grant). Session-owner only: the grant must
 * belong to the signed-in user. DELETE disconnects; PATCH toggles the
 * connection's SSIS permission. Both take effect on the very next MCP
 * call because token verification and tool handlers read grant state
 * live.
 */
import { NextResponse } from "next/server";
import { mcpConfig } from "@/lib/env";
import { loadActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { revokeGrant, setGrantSsisAccess } from "@/server/domain/oauth";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!mcpConfig()) return new Response("Not Found", { status: 404 });
  const actor = await loadActor();
  if (!actor) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "Sign in required." } },
      { status: 401 }
    );
  }
  const { id } = await params;
  const exec = await getDb();
  const revoked = await revokeGrant(exec, id, actor.userId);
  if (!revoked) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Connection not found." } },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true });
}

/**
 * Toggle the connection's SSIS permission. Body: { "ssisAccess": boolean }.
 * Owner-only (a grant owned by someone else is a 404, exactly like a
 * missing one — its existence is not leaked).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!mcpConfig()) return new Response("Not Found", { status: 404 });
  const actor = await loadActor();
  if (!actor) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "Sign in required." } },
      { status: 401 }
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const ssisAccess =
    body !== null && typeof body === "object"
      ? (body as { ssisAccess?: unknown }).ssisAccess
      : undefined;
  if (typeof ssisAccess !== "boolean") {
    return NextResponse.json(
      { error: { code: "invalid_request", message: "Expected a JSON body with ssisAccess." } },
      { status: 400 }
    );
  }
  const { id } = await params;
  const exec = await getDb();
  const updated = await setGrantSsisAccess(exec, id, actor.userId, ssisAccess);
  if (!updated) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Connection not found." } },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true, ssisAccess });
}
