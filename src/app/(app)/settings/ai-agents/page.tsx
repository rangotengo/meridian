import { requireVerifiedActor } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { listConnectionsForUser } from "@/server/domain/oauth";
import { Card, PageHeader } from "@/components/ds/card";
import { AiAgentsManager, type ConnectionItem } from "./ai-agents-manager";

export const metadata = { title: "Connected AI agents" };

/**
 * Connected AI agents: the OAuth grants this user has issued to MCP
 * clients (Claude, ChatGPT, …). Session-owner only — the list is built
 * from the signed-in user's grants, and disconnect goes through the
 * owner-checked DELETE route. This page deliberately does not consult
 * the MCP config gate: the grants tables exist regardless, so existing
 * connections stay visible (and revocable in effect — with the gate
 * closed no token can be used anyway) even when MCP is not configured.
 */
export default async function AiAgentsPage() {
  const actor = await requireVerifiedActor();
  const exec = await getDb();
  const connections = await listConnectionsForUser(exec, actor.userId);

  const items: ConnectionItem[] = connections.map((c) => ({
    id: c.grant.id,
    clientName: c.grant.clientName,
    status: c.status,
    scopes: c.grant.scopes,
    ssisAccess: c.grant.ssisAccess,
    familyName: c.familyName,
    accounts: c.accounts,
    createdAt: c.grant.createdAt,
    lastUsedAt: c.grant.lastUsedAt,
    expiresAt: c.grant.expiresAt,
    history: c.history.map((h) => ({
      action: h.action,
      tool: h.tool,
      createdAt: h.createdAt
    })),
    timezone: c.familyTimezone
  }));

  return (
    <>
      <PageHeader
        title="Connected AI agents"
        subtitle="AI assistants you have connected to Meridian with read-only access, through MCP."
      />

      <Card className="space-y-2">
        <h3 className="text-sm font-semibold">How this works</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          When you connect an AI assistant such as Claude or ChatGPT, it can read the Meridian data
          covered by the permissions listed below — it cannot change anything. The answers the
          assistant generates are produced by its provider: any Meridian data a tool returns is sent
          to that provider and handled under the provider&rsquo;s own privacy policy, not
          Meridian&rsquo;s. Each connection is bound to one household, lasts up to 90 days, and
          disconnecting takes effect immediately.
        </p>
      </Card>

      <AiAgentsManager connections={items} />
    </>
  );
}
