import { requireSuperAdmin } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { listDebugLogs } from "@/server/observability/debug-log";
import { getScheduleFreshness } from "@/server/observability/schedule-health";
import { listFlags } from "@/server/flags";
import { listRecentJobs } from "@/server/queue";
import { listPendingInstanceInvitations } from "@/server/domain/instance-invitations";
import { env } from "@/lib/env";
import { Card, PageHeader, Badge } from "@/components/ds/card";
import { SubmitButton } from "@/components/ds/submit-button";
import { toggleFlagAction, replayJobAction, revokeInstanceInvitationAction } from "./actions";
import { InstanceInviteForm } from "./instance-invite-form";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Admin" };

export default async function AdminPage() {
  const actor = await requireSuperAdmin();
  const db = getDb();

  const [logs, flags, jobs, instanceInvitations, freshness] = await Promise.all([
    listDebugLogs(db, { limit: 50 }),
    listFlags(db),
    listRecentJobs(db, 30),
    listPendingInstanceInvitations(db, actor),
    getScheduleFreshness(db)
  ]);

  return (
    <div className="min-h-screen space-y-6 bg-bg px-3 py-6 pb-12 text-fg sm:px-6 lg:px-10">
      <PageHeader
        title="Operations"
        subtitle="Support diagnostics visible only to platform super admins."
      />

      <Card>
        <h2 className="mb-3 text-base font-medium text-primary">Feature flags</h2>
        <ul className="divide-y divide-border">
          {flags.map((f) => (
            <li key={f.key} className="flex items-center justify-between gap-4 py-2.5">
              <div>
                <p className="text-sm font-medium">{f.key}</p>
                <p className="text-xs text-muted-foreground">{f.description}</p>
              </div>
              <form action={toggleFlagAction} className="flex items-center gap-2">
                <input type="hidden" name="key" value={f.key} />
                <Badge tone={f.enabled ? "success" : "neutral"}>{f.enabled ? "on" : "off"}</Badge>
                <SubmitButton name="enabled" value={f.enabled ? "off" : "on"} variant="secondary">
                  {f.enabled ? "Disable" : "Enable"}
                </SubmitButton>
              </form>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Flag toggles are audited via the debug log.
        </p>
      </Card>

      <Card>
        <h2 className="mb-3 text-base font-medium text-primary">Instance invitations</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Invite someone to create a new household on this instance. The link expires in 7 days.
        </p>
        <InstanceInviteForm manualDelivery={env.MAIL_TRANSPORT === "manual"} />
        {instanceInvitations.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No pending instance invitations.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {instanceInvitations.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between py-2.5 text-sm">
                <div>
                  <p>{inv.email}</p>
                  <p className="text-xs text-muted-foreground">
                    created{" "}
                    {new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(inv.createdAt)} ·
                    expires{" "}
                    {new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(inv.expiresAt)}
                  </p>
                </div>
                <form action={revokeInstanceInvitationAction}>
                  <input type="hidden" name="invitationId" value={inv.id} />
                  <SubmitButton variant="secondary">Revoke</SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-base font-medium text-primary">Scheduled work</h2>
        <ul className="divide-y divide-border">
          {freshness.checks.map((c) => (
            <li key={c.key} className="flex items-center justify-between gap-4 py-2.5 text-sm">
              <div>
                <p className="font-medium">{c.queue}</p>
                <p className="text-xs text-muted-foreground">
                  {c.lastRunAt
                    ? `last ran ${new Intl.DateTimeFormat("en", { dateStyle: "short", timeStyle: "short" }).format(new Date(c.lastRunAt))}`
                    : "never ran"}
                  {c.nextRunAt
                    ? ` · next due ${new Intl.DateTimeFormat("en", { dateStyle: "short", timeStyle: "short" }).format(new Date(c.nextRunAt))}`
                    : ""}
                  {c.status === "stale"
                    ? ` · overdue by ${Math.round(c.overdueSeconds / 60)} min`
                    : ""}
                </p>
              </div>
              <Badge
                tone={
                  c.status === "ok"
                    ? "success"
                    : c.status === "stale"
                      ? "destructive"
                      : c.status === "missing"
                        ? "warning"
                        : "neutral"
                }
              >
                {c.status === "ok"
                  ? "on schedule"
                  : c.status === "stale"
                    ? "stale"
                    : c.status === "missing"
                      ? "not registered"
                      : "disabled"}
              </Badge>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          A schedule counts as stale when it stays due past its freshness budget (1 hour for
          recurring posting, 6 hours for the nightly jobs) — that means the worker is not ticking.
          Stale schedules degrade /api/health without failing it.
        </p>
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-medium text-primary">Background jobs (recent)</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-160 text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="py-2 font-medium">
                  Queue
                </th>
                <th scope="col" className="py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 font-medium">
                  Attempts
                </th>
                <th scope="col" className="py-2 font-medium">
                  Created
                </th>
                <th scope="col" className="py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="py-2">{j.queue}</td>
                  <td className="py-2">
                    <Badge
                      tone={
                        j.status === "completed"
                          ? "success"
                          : j.status === "dead"
                            ? "destructive"
                            : j.status === "pending"
                              ? "warning"
                              : "neutral"
                      }
                    >
                      {j.status}
                    </Badge>
                    {j.last_error ? (
                      <span className="ml-2 text-xs text-destructive">
                        {j.last_error.slice(0, 60)}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2">
                    {j.attempts}/{j.max_attempts}
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {fmtDate(String(j.created_at).slice(0, 10))}
                  </td>
                  <td className="py-2 text-right">
                    {j.status === "dead" ? (
                      <form action={replayJobAction}>
                        <input type="hidden" name="jobId" value={j.id} />
                        <SubmitButton variant="secondary">Replay</SubmitButton>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No jobs recorded yet.</p>
        ) : null}
      </Card>

      <Card>
        <h2 className="mb-3 text-base font-medium text-primary">Support diagnostics</h2>
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No diagnostics recorded. That is usually good news.
          </p>
        ) : (
          <ul className="space-y-2">
            {logs.map((l) => (
              <li key={l.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      l.level === "error"
                        ? "destructive"
                        : l.level === "warn"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {l.level}
                  </Badge>
                  <span className="font-medium">{l.category}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Intl.DateTimeFormat("en", {
                      dateStyle: "short",
                      timeStyle: "short"
                    }).format(l.createdAt)}
                  </span>
                </div>
                <p className="mt-1">{l.message}</p>
                {Object.keys((l.metadata as object) ?? {}).length > 0 ? (
                  <pre className="mt-2 overflow-x-auto rounded bg-bg p-2 text-xs text-muted-foreground">
                    {JSON.stringify(l.metadata, null, 2)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
