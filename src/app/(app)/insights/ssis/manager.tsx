"use client";

import { useActionState, useMemo, useState } from "react";
import {
  importSsisAction,
  refreshSsisAction,
  setSsisBoAccountAction,
  type SsisImportResult
} from "./actions";
import { SsisLineChart, SsisPurchaseChart } from "./charts";
import { Alert, Card, EmptyState } from "@/components/ds/card";
import { Field, FormError, Input } from "@/components/ds/form";
import { SubmitButton } from "@/components/ds/submit-button";
import { Amount } from "@/components/finance/amount";
import { fmtDate } from "@/lib/format";
import type { SsisInsightData } from "@/server/domain/ssis";
import { ChevronDownIcon, ChevronUpIcon, RefreshCwIcon, UploadIcon } from "lucide-react";

function formatNav(minor: number | null): string {
  return minor === null ? "—" : (minor / 100).toFixed(2);
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/** Outcome of an import/refresh: counts, skipped rows, and partial-success warnings. */
export function SsisSyncFeedback({ result }: { result?: SsisImportResult }) {
  if (!result) return null;
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Updated {result.purchases} purchases · {result.statement} statement rows ·{" "}
        {result.navPoints} NAV points
        {result.skipped > 0 ? ` · ${result.skipped} malformed rows skipped` : ""}.
      </p>
      {result.warnings.length > 0 ? (
        <Alert title="Completed with warnings" tone="warning">
          <ul className="list-inside list-disc">
            {result.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * Setup is complete once the BO account is configured AND data has arrived
 * (snapshot import or live refresh). Until then the panel stays expanded:
 * there is no collapse control for incomplete setup.
 *
 * The collapsed default is decided on mount. Completing setup during this
 * visit (e.g. importing a snapshot) leaves the panel open so the
 * import/refresh confirmation stays visible; the summary row is the
 * default on the next visit.
 */
function Controls({ data }: { data: SsisInsightData }) {
  const setupComplete = data.hasBoAccount && data.hasData;
  const [expanded, setExpanded] = useState(!setupComplete);
  const [importState, importAction] = useActionState(importSsisAction, undefined);
  const [refreshState, refreshAction] = useActionState(refreshSsisAction, undefined);
  const [boState, boAction] = useActionState(setSsisBoAccountAction, undefined);

  if (!expanded) {
    const summaryParts = [`BO account ${data.boAccountMasked}`];
    summaryParts.push(
      `${data.purchases.length} purchase${data.purchases.length === 1 ? "" : "s"} · ` +
        `${data.statement.length} statement row${data.statement.length === 1 ? "" : "s"}`
    );
    if (data.lastFetchedAt) {
      // lastFetchedAt is a full ISO timestamp (unlike the date-only
      // strings fmtDate handles), so format it the same way the page
      // header does.
      summaryParts.push(
        `Last updated ${new Date(data.lastFetchedAt).toLocaleString()} via ${
          data.lastSource === "refresh" ? "live refresh" : "snapshot import"
        }`
      );
    }
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">SSIS setup</h2>
            <p className="text-sm text-muted-foreground">{summaryParts.join(" · ")}</p>
          </div>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded={false}
            aria-controls="ssis-setup-panel"
            className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-accent"
          >
            Edit setup <ChevronDownIcon className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Refresh from Siddhartha Capital</h2>
          <p className="text-sm text-muted-foreground">
            {data.hasBoAccount
              ? `BO account ${data.boAccountMasked} is configured. Refresh fetches purchases, statement and NAV history directly.`
              : "Set your BO account number below to enable live refresh. It is stored only for server-side refresh calls and never shown in full."}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <form action={refreshAction}>
            <SubmitButton variant="secondary" disabled={!data.hasBoAccount}>
              <RefreshCwIcon className="h-4 w-4" /> Refresh now
            </SubmitButton>
          </form>
          {setupComplete ? (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-expanded={true}
              aria-controls="ssis-setup-panel"
              className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-accent"
            >
              Collapse <ChevronUpIcon className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
      <div id="ssis-setup-panel" className="space-y-5">
        <FormError message={refreshState?.ok === false ? refreshState.error : undefined} />
        <SsisSyncFeedback result={refreshState?.ok ? refreshState.data : undefined} />

        <div className="border-t border-border pt-4">
          <h3 className="text-sm font-semibold">Import a snapshot</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload the exported SSIS JSON (the nav.json shape). Only the fields this page displays
            are kept — personal identifiers in the file are discarded on import.
          </p>
          <form action={importAction} className="mt-3 flex flex-wrap items-center gap-3">
            <input
              type="file"
              name="snapshot"
              accept="application/json,.json"
              required
              className="text-sm file:mr-3 file:rounded-lg file:border file:border-border file:bg-card file:px-3 file:py-2 file:text-sm file:font-medium"
            />
            <SubmitButton variant="secondary">
              <UploadIcon className="h-4 w-4" /> Import snapshot
            </SubmitButton>
          </form>
          <FormError message={importState?.ok === false ? importState.error : undefined} />
          <div className="mt-2">
            <SsisSyncFeedback result={importState?.ok ? importState.data : undefined} />
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <h3 className="text-sm font-semibold">BO account number</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.hasBoAccount
              ? `Currently set to ${data.boAccountMasked}. Enter a new number to replace it. This insight holds one holder's data: saving a different number requires confirming the switch below, which clears the current holder's purchases and statement.`
              : "Not set. Refresh stays disabled until it is configured."}
          </p>
          <form action={boAction} className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="BO account number">
              <Input
                name="boAccountNo"
                inputMode="numeric"
                autoComplete="off"
                placeholder="e.g. 1301…"
                required
              />
            </Field>
            <SubmitButton variant="secondary">Save</SubmitButton>
            {data.hasBoAccount && (data.purchases.length > 0 || data.statement.length > 0) ? (
              <label className="flex w-full items-start gap-2 text-sm text-muted-foreground">
                <input type="checkbox" name="resetExistingData" className="mt-0.5" />
                <span>
                  This is a different holder: clear the existing purchases and statement and switch.
                </span>
              </label>
            ) : null}
          </form>
          <FormError message={boState?.ok === false ? boState.error : undefined} />
          {boState?.ok ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Saved.
              {boState.data?.dataReset
                ? " The previous holder's purchases and statement were cleared."
                : ""}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function SummaryCards({ data }: { data: SsisInsightData }) {
  const { summary } = data;
  const profitTone =
    summary.profitMinor === null
      ? ""
      : summary.profitMinor >= 0
        ? "text-income"
        : "text-destructive";
  const cards: { title: string; value: React.ReactNode; subtext?: string; tone?: string }[] = [
    { title: "Total Units", value: summary.totalUnits },
    {
      title: "Total Invested",
      value:
        summary.totalInvestedMinor === null ? (
          "—"
        ) : (
          <Amount minor={summary.totalInvestedMinor} currency={data.currency} />
        )
    },
    {
      title: "Current Value",
      value:
        summary.currentValueMinor === null ? (
          "—"
        ) : (
          <Amount minor={summary.currentValueMinor} currency={data.currency} />
        )
    },
    {
      title: "Profit / Loss",
      value:
        summary.profitMinor === null ? (
          "—"
        ) : (
          <Amount minor={summary.profitMinor} currency={data.currency} signed />
        ),
      subtext: summary.returnPercent !== null ? formatPercent(summary.returnPercent) : undefined,
      tone: profitTone
    },
    {
      title: "Return",
      value: formatPercent(summary.returnPercent),
      tone: profitTone
    },
    {
      title: "Current NAV",
      value: formatNav(summary.currentNavMinor),
      subtext: summary.currentNavDate ? `as of ${fmtDate(summary.currentNavDate)}` : undefined
    }
  ];
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6">
      {cards.map((card) => (
        <Card key={card.title}>
          <p className="text-sm font-medium text-muted-foreground">{card.title}</p>
          <p className={`mt-2 text-2xl font-bold tabular ${card.tone ?? ""}`}>{card.value}</p>
          {card.subtext ? (
            <p className="mt-1 text-sm font-medium text-muted-foreground">{card.subtext}</p>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

function NavStats({ data }: { data: SsisInsightData }) {
  const stats = data.navStats;
  const items = [
    { title: "Current NAV", value: formatNav(stats.currentNavMinor) },
    { title: "Average Purchase NAV", value: formatNav(stats.avgNavMinor) },
    { title: "Highest Purchase NAV", value: formatNav(stats.maxNavMinor) },
    {
      title: "Lowest Purchase NAV",
      value: formatNav(stats.minNavMinor),
      subtext:
        stats.changeFromMinPercent !== null
          ? `${formatPercent(stats.changeFromMinPercent)} from lowest`
          : undefined
    }
  ];
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {items.map((item) => (
        <Card key={item.title}>
          <p className="text-sm font-medium text-muted-foreground">{item.title}</p>
          <p className="mt-2 text-xl font-bold tabular">{item.value}</p>
          {item.subtext ? (
            <p className="mt-1 text-sm text-muted-foreground">{item.subtext}</p>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

const thCls = "py-2 font-medium";
const thRight = "py-2 text-right font-medium";

function PurchasesTable({ data }: { data: SsisInsightData }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const rows = useMemo(
    () =>
      data.purchases.filter((p) => {
        if (from && p.applyDate < from) return false;
        if (to && p.applyDate > to) return false;
        return true;
      }),
    [data.purchases, from, to]
  );
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-base font-semibold">Purchase History</h2>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          {from || to ? (
            <button
              type="button"
              onClick={() => {
                setFrom("");
                setTo("");
              }}
              className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent"
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No purchases in this range" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className={thCls}>
                  Request No
                </th>
                <th scope="col" className={thCls}>
                  Date
                </th>
                <th scope="col" className={thRight}>
                  Units
                </th>
                <th scope="col" className={thRight}>
                  Amount
                </th>
                <th scope="col" className={thRight}>
                  NAV
                </th>
                <th scope="col" className={thCls}>
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.requestNo}>
                  <td className="py-2 tabular">{row.requestNo}</td>
                  <td className="py-2">{fmtDate(row.applyDate)}</td>
                  <td className="py-2 text-right tabular">{row.units}</td>
                  <td className="py-2 text-right">
                    <Amount minor={row.amountMinor} currency={data.currency} />
                  </td>
                  <td className="py-2 text-right tabular">{formatNav(row.purchaseNavMinor)}</td>
                  <td className="py-2">{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function StatementTable({ data }: { data: SsisInsightData }) {
  return (
    <Card>
      <h2 className="mb-3 text-base font-semibold">SIP Statement</h2>
      {data.statement.length === 0 ? (
        <EmptyState title="No statement rows yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className={thCls}>
                  Date
                </th>
                <th scope="col" className={thCls}>
                  Trans No
                </th>
                <th scope="col" className={thRight}>
                  Units
                </th>
                <th scope="col" className={thRight}>
                  NAV
                </th>
                <th scope="col" className={thRight}>
                  Credit
                </th>
                <th scope="col" className={thRight}>
                  Debit
                </th>
                <th scope="col" className={thRight}>
                  Charges
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.statement.map((row) => (
                <tr key={row.transNo}>
                  <td className="py-2">{fmtDate(row.installmentDate)}</td>
                  <td className="py-2 tabular">{row.transNo}</td>
                  <td className="py-2 text-right tabular">{row.units ?? "—"}</td>
                  <td className="py-2 text-right tabular">{formatNav(row.appliedNavMinor)}</td>
                  <td className="py-2 text-right">
                    <Amount minor={row.amountCrMinor} currency={data.currency} />
                  </td>
                  <td className="py-2 text-right">
                    <Amount minor={row.amountDrMinor} currency={data.currency} />
                  </td>
                  <td className="py-2 text-right">
                    <Amount
                      minor={row.otherChargesMinor + row.sebonFeeMinor}
                      currency={data.currency}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function NavHistoryTable({ data }: { data: SsisInsightData }) {
  return (
    <Card>
      <h2 className="mb-3 text-base font-semibold">NAV History</h2>
      {data.navSeries.length === 0 ? (
        <EmptyState title="No NAV history yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className={thCls}>
                  Date (AD)
                </th>
                <th scope="col" className={thCls}>
                  Date (BS)
                </th>
                <th scope="col" className={thRight}>
                  NAV
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...data.navSeries].reverse().map((point) => (
                <tr key={point.engDate}>
                  <td className="py-2">{fmtDate(point.engDate)}</td>
                  <td className="py-2 tabular">{point.nepDate}</td>
                  <td className="py-2 text-right tabular">{formatNav(point.navMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function SsisManager({ data }: { data: SsisInsightData }) {
  return (
    <div className="space-y-6">
      {data.canManage ? <Controls data={data} /> : null}
      {!data.hasData ? (
        <EmptyState
          title="No SSIS data yet"
          hint={
            data.canManage
              ? "Import a snapshot JSON or configure your BO account number and refresh from Siddhartha Capital. This insight is separate from your Meridian accounts — nothing here changes your balances."
              : "Nothing has been imported for this insight yet. Ask a family admin to import a snapshot or refresh it."
          }
        />
      ) : (
        <>
          <SummaryCards data={data} />
          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <h2 className="mb-3 text-base font-semibold">NAV History</h2>
              <SsisLineChart
                dates={data.navSeries.map((p) => p.engDate)}
                series={[
                  {
                    label: "NAV",
                    color: "#2563eb",
                    values: data.navSeries.map((p) => p.navMinor / 100),
                    format: (v) => v.toFixed(2)
                  }
                ]}
              />
            </Card>
            <Card>
              <h2 className="mb-3 text-base font-semibold">Unit Purchase History</h2>
              <SsisPurchaseChart
                dates={data.purchaseSeries.map((p) => p.date)}
                units={data.purchaseSeries.map((p) => Number.parseFloat(p.units))}
                navs={data.purchaseSeries.map((p) =>
                  p.purchaseNavMinor === null ? null : p.purchaseNavMinor / 100
                )}
              />
            </Card>
          </div>
          <Card>
            <h2 className="mb-3 text-base font-semibold">Investment Value Growth</h2>
            <SsisLineChart
              dates={data.valueGrowth.map((p) => p.date)}
              series={[
                {
                  label: "Invested",
                  color: "#2563eb",
                  values: data.valueGrowth.map((p) =>
                    p.investedMinor === null ? null : p.investedMinor / 100
                  ),
                  format: (v) => v.toLocaleString("en", { maximumFractionDigits: 0 })
                },
                {
                  label: "Current value",
                  color: "#059669",
                  values: data.valueGrowth.map((p) =>
                    p.valueMinor === null ? null : p.valueMinor / 100
                  ),
                  format: (v) => v.toLocaleString("en", { maximumFractionDigits: 0 })
                }
              ]}
            />
          </Card>
          <NavStats data={data} />
          <PurchasesTable data={data} />
          <StatementTable data={data} />
          <NavHistoryTable data={data} />
        </>
      )}
    </div>
  );
}
