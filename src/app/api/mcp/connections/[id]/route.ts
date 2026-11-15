/**
 * Disconnect an MCP connection (grant). Session-owner only: the grant
 * must belong to the signed-in user. Revocation is effective on the very
 * next MCP call because token verification reads grant state live.
 * (Full settings UI is a later stage; this is the PoC surface.)
 */
import { NextResponse } from "next/server";
import { mcpConfig } from "@/lib/env";
import { loadActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { revokeGrant } from "@/server/domain/oauth";

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
