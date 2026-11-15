import Link from "next/link";
import { notFound } from "next/navigation";
import { requireVerifiedActor, currentFamily } from "@/server/auth/context";
import { todayIn } from "@/lib/datetime";
import { getDb } from "@/server/db/client";
import { getAccountOverview, isLiability, familyMemberOptions } from "@/server/domain/accounts";
import { getUserPrivacyMode } from "@/server/domain/users";
import { Badge, Card, PageHeader } from "@/components/ds/card";
import { Amount, Sparkline } from "@/components/finance/amount";
import { fmtDate } from "@/lib/format";
import { ledgerToDisplayBalance, minorToDecimal } from "@/lib/money";
import { AccountActions } from "./actions-panel";
import { ValuationForm } from "./valuation-form";
import { ValuationRowActions } from "./valuation-row-actions";

export const metadata = { title: "Account" };

export default async function AccountDetailPage({
  params
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  const actor = await requireVerifiedActor();
  const family = await currentFamily(actor);
  const db = getDb();

  let overview;
  try {
    overview = await getAccountOverview(db, actor, accountId);
  } catch {
    notFound();
  }
  const privacy = await getUserPrivacyMode(db, actor.userId);
  const { account, level, series, recentActivity, shares, valuationDriven, isJoint } = overview;
  const members = await familyMemberOptions(db, actor.familyId);

  return (
    <div className="space-y-6 pb-6 lg:pb-12">
      <PageHeader
        title={account.name}
        subtitle={`${labelForType(account.type)}${account.institution ? ` · ${account.institution}` : ""}`}
        actions={
          level === "full_control" ? (
            <AccountActions
              accountId={account.id}
              status={account.status}
              accountName={account.name}
              institution={account.institution}
              includedInReports={account.includedInReports}
              members={members}
            />
          ) : undefined
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-medium text-primary">Balance</h2>
            <div className="flex gap-2">
              <Badge tone={isLiability(account.type) ? "warning" : "success"}>
                {isLiability(account.type) ? "Liability" : "Asset"}
              </Badge>
              {!isJoint ? <Badge tone="primary">personal</Badge> : null}
              {account.status !== "active" ? <Badge tone="neutral">{account.status}</Badge> : null}
            </div>
          </div>
          <p className="tabular mt-1 text-3xl font-semibold">
            <Amount
              minor={overview.displayBalanceMinor}
              currency={account.currency}
              masked={privacy}
            />
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Opened {fmtDate(account.openedOn)}</p>
          <div className="mt-4">
            <Sparkline
              points={series.map((pt) => ({ date: pt.date, valueMinor: pt.balanceMinor }))}
              masked={privacy}
            />
          </div>
        </Card>

        <Card className="space-y-3">
          <h2 className="text-base font-medium text-primary">Shortcuts</h2>
          <Link
            href={`/transactions/new?account=${account.id}`}
            className="block rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-surface-hover"
          >
            + New transaction
          </Link>
          {valuationDriven && level === "full_control" ? (
            <a
              href="#valuation"
              className="block rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-surface-hover"
            >
              Update valuation
            </a>
          ) : null}
          <Link
            href="/transactions?kind=transfer"
            className="block rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-surface-hover"
          >
            Move money (transfers)
          </Link>
          <p className="text-xs text-muted-foreground">
            {level === "full_control"
              ? "You have full control of this account."
              : level === "read_write"
                ? "You can edit details but not amounts or dates."
                : "You have view-only access."}
          </p>
        </Card>
      </div>

      {level === "full_control" ? (
        <Card>
          <h2 className="mb-2 text-base font-medium text-primary">Sharing</h2>
          {shares.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not shared with anyone yet.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {shares.map((s) => (
                <li key={s.userId} className="flex items-center justify-between py-2">
                  <span>{s.userName}</span>
                  <Badge tone="primary">{s.permission.replace("_", " ")}</Badge>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Manage sharing and lifecycle from the account menu.
          </p>
        </Card>
      ) : null}

      {valuationDriven && level === "full_control" ? (
        <ValuationForm
          accountId={account.id}
          currency={account.currency}
          today={todayIn(family.timezone)}
        />
      ) : null}

      <Card>
        <h2 className="mb-3 text-base font-medium text-primary">Activity</h2>
        {recentActivity.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {recentActivity.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  {e.kind === "valuation" ? (
                    <span className="truncate text-sm font-medium">{e.name}</span>
                  ) : (
                    <Link
                      href={`/transactions/${e.id}`}
                      className="truncate text-sm font-medium hover:underline"
                    >
                      {e.name}
                    </Link>
                  )}
                  <p className="text-xs text-muted-foreground">{fmtDate(e.date)}</p>
                </div>
                {e.kind === "valuation" && level === "full_control" ? (
                  <ValuationRowActions
                    entryId={e.id}
                    date={e.date}
                    amount={minorToDecimal(
                      ledgerToDisplayBalance(e.amountMinor, account.type),
                      account.currency
                    )}
                    kind={e.valuationKind ?? "current"}
                    currency={account.currency}
                  />
                ) : null}
                <Amount
                  minor={e.kind === "valuation" ? e.amountMinor : -e.amountMinor}
                  currency={account.currency}
                  masked={privacy}
                  signed
                  colorize
                  className="shrink-0 text-sm"
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function labelForType(type: string): string {
  switch (type) {
    case "depository":
      return "Cash";
    case "credit_card":
      return "Credit card";
    case "other_asset":
      return "Other asset";
    case "other_liability":
      return "Other liability";
    default:
      return type;
  }
}
