"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Unplug } from "lucide-react";
import { Badge, Card, EmptyState } from "@/components/ds/card";
import { Dialog, useDialogClose } from "@/components/ds/dialog";
import { FormError } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { SCOPE_LABELS } from "@/server/mcp/scopes";

export type ConnectionItem = {
  id: string;
  clientName: string;
  status: "active" | "revoked" | "expired";
  scopes: string[];
  familyName: string | null;
  /** null = all accounts the user can access; otherwise the named subset. */
  accounts: { id: string; name: string }[] | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  history: { action: string; tool: string | null; createdAt: Date }[];
  timezone: string;
};

function formatDateTime(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone
  }).format(value);
}

function historyLabel(entry: ConnectionItem["history"][number]): string {
  if (entry.action === "oauth_grant.created") return "Connected";
  if (entry.action === "oauth_grant.revoked") return "Disconnected";
  if (entry.action === "mcp.tool_called") return entry.tool ?? "Tool call";
  return entry.action;
}

function DisconnectForm({ connectionId }: { connectionId: string }) {
  const close = useDialogClose();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const res = await fetch(`/api/mcp/connections/${connectionId}`, { method: "DELETE" });
      if (!res.ok) {
        setError(
          res.status === 404
            ? "This connection no longer exists."
            : "Disconnect failed. Please try again."
        );
        return;
      }
    } catch {
      setError("Disconnect failed. Please try again.");
      return;
    }
    close();
    router.refresh();
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {error ? <FormError message={error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={close}
          className="rounded-lg px-3.5 py-2 text-sm font-medium hover:bg-surface-inset-hover"
        >
          Cancel
        </button>
        <SubmitButton variant="destructive">Disconnect</SubmitButton>
      </div>
    </form>
  );
}

function DisconnectButton({ connection }: { connection: ConnectionItem }) {
  return (
    <Dialog
      trigger={
        <span className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10">
          <Unplug className="h-3.5 w-3.5" />
          Disconnect
        </span>
      }
      title={`Disconnect ${connection.clientName}?`}
      description="The assistant immediately loses access to your Meridian data, and its tokens stop working. Reconnecting later creates a brand-new connection — this one is not revived."
    >
      <DisconnectForm connectionId={connection.id} />
    </Dialog>
  );
}

export function AiAgentsManager({ connections }: { connections: ConnectionItem[] }) {
  if (connections.length === 0) {
    return (
      <EmptyState
        title="No AI agents connected"
        hint="When you connect an assistant such as Claude or ChatGPT to Meridian, it will appear here with its permissions and recent activity."
      />
    );
  }

  return (
    <div className="space-y-4">
      {connections.map((c) => (
        <Card key={c.id} className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{c.clientName}</span>
                {c.status === "active" ? (
                  <Badge tone="success">Active</Badge>
                ) : c.status === "revoked" ? (
                  <Badge tone="destructive">Disconnected</Badge>
                ) : (
                  <Badge tone="warning">Expired</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Household: {c.familyName ?? "Unknown household"} • Connected{" "}
                {formatDateTime(c.createdAt, c.timezone)}
                {c.lastUsedAt
                  ? ` • Last used ${formatDateTime(c.lastUsedAt, c.timezone)}`
                  : " • Never used"}
                {c.status === "active"
                  ? ` • Access until ${formatDateTime(c.expiresAt, c.timezone)}`
                  : ""}
              </p>
            </div>
            {c.status === "active" ? <DisconnectButton connection={c} /> : null}
          </div>

          <div className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Permissions
              </p>
              <ul className="mt-1.5 space-y-1 text-muted-foreground">
                {c.scopes.map((scope) => (
                  <li key={scope}>{SCOPE_LABELS[scope] ?? scope}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Account access
              </p>
              <p className="mt-1.5 text-muted-foreground">
                {c.accounts === null
                  ? "All accounts you can access"
                  : c.accounts.map((a) => a.name).join(", ")}
              </p>
            </div>
          </div>

          {c.history.length > 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Recent activity
              </p>
              <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
                {c.history.map((h, i) => (
                  <li key={i}>
                    {formatDateTime(h.createdAt, c.timezone)} — {historyLabel(h)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
