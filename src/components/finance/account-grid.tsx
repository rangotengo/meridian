"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { BuildingIcon, ClockIcon, PlusIcon, TrendingDownIcon, WalletIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtMoney } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";

export type AccountCardModel = {
  id: string;
  name: string;
  type: string;
  institution: string | null;
  displayBalanceMinor: number;
  currency: string;
  status: string;
  isJoint: boolean;
  level: string;
  includedInReports: boolean;
};

const typeAccent: Record<string, string> = {
  depository: "bg-blue-500",
  credit_card: "bg-violet-500",
  other_asset: "bg-emerald-500",
  other_liability: "bg-rose-500"
};

const filterTabs = [
  { value: "all", label: "All" },
  { value: "depository", label: "Cash" },
  { value: "credit_card", label: "Credit" },
  { value: "other_asset", label: "Assets" },
  { value: "other_liability", label: "Debts" }
] as const;

function typeLabel(type: string) {
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

export function AccountsView({
  accounts,
  privacy,
  assetsMinor,
  liabilitiesMinor,
  currency
}: {
  accounts: AccountCardModel[];
  privacy: boolean;
  assetsMinor: number;
  liabilitiesMinor: number;
  currency: string;
}) {
  const router = useRouter();
  const [selectedType, setSelectedType] = useState<(typeof filterTabs)[number]["value"]>("all");
  const filtered = useMemo(
    () =>
      selectedType === "all"
        ? accounts
        : accounts.filter((account) => account.type === selectedType),
    [accounts, selectedType]
  );

  const summary = [
    {
      label: "Assets",
      value: privacy ? "••••" : fmtMoney(assetsMinor, currency),
      icon: WalletIcon
    },
    {
      label: "Liabilities",
      value: privacy ? "••••" : fmtMoney(liabilitiesMinor, currency),
      icon: TrendingDownIcon
    },
    {
      label: "Linked accounts",
      value: String(accounts.length),
      icon: BuildingIcon
    }
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {summary.map((card) => (
          <div
            key={card.label}
            className="flex items-center gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10"
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
              <card.icon className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{card.label}</p>
              <p className="tabular-nums text-base font-semibold tracking-tight">{card.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {filterTabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setSelectedType(tab.value)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              selectedType === tab.value
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          variant={accounts.length === 0 ? "accounts" : "filter"}
          title={accounts.length === 0 ? "No accounts yet" : "No accounts in this category"}
          description={
            accounts.length === 0
              ? "Add a cash account, credit card, or other asset to start the ledger."
              : "Try a different filter or add a new account."
          }
          actionLabel="Add account"
          onAction={() => router.push("/accounts/new")}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((account, index) => (
            <motion.div
              key={account.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: index * 0.05 }}
            >
              <Link
                href={`/accounts/${account.id}`}
                className="group relative block overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 transition-shadow hover:shadow-md"
              >
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 w-1",
                    typeAccent[account.type] ?? "bg-primary"
                  )}
                />
                <div className="p-4 pl-5">
                  <div className="flex items-center gap-2">
                    <div className="flex size-8 items-center justify-center rounded-full bg-muted">
                      <BuildingIcon className="size-4 text-muted-foreground" />
                    </div>
                    {account.institution ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {account.institution}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3">
                    <p className="text-sm font-semibold">{account.name}</p>
                    <p className="text-xs text-muted-foreground">{typeLabel(account.type)}</p>
                  </div>
                  <p className="mt-3 tabular-nums text-xl font-bold tracking-tight">
                    {privacy ? "•••••" : fmtMoney(account.displayBalanceMinor, account.currency)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {account.status !== "active" ? (
                      <Badge variant="outline">{account.status}</Badge>
                    ) : null}
                    {!account.isJoint ? <Badge variant="secondary">personal</Badge> : null}
                    {account.level !== "full_control" ? (
                      <Badge variant="outline">{account.level}</Badge>
                    ) : null}
                    {!account.includedInReports ? <Badge variant="outline">excluded</Badge> : null}
                    <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <ClockIcon className="size-3" />
                      {account.currency}
                    </span>
                  </div>
                </div>
              </Link>
            </motion.div>
          ))}
          <Link
            href="/accounts/new"
            className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <PlusIcon className="size-5" />
            Add account
          </Link>
        </div>
      )}
    </div>
  );
}
