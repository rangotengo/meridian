"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeftRightIcon, MessageCircleIcon, PlusIcon, WalletIcon } from "lucide-react";
import { useDashboardData } from "@/components/finance/dashboard-data";
import { TransactionComposerDialog } from "@/components/finance/transaction-composer";

const linkActions = [
  { href: "/quick-add", label: "Quick add", hint: "Capture a transaction fast", icon: PlusIcon },
  {
    href: "/accounts/new",
    label: "New account",
    hint: "Cash, credit, or other asset",
    icon: WalletIcon
  },
  {
    href: "/chat",
    label: "Ask assistant",
    hint: "Review spending in plain language",
    icon: MessageCircleIcon
  }
];

function ActionContent({
  icon: Icon,
  label,
  hint
}: {
  icon: typeof PlusIcon;
  label: string;
  hint: string;
}) {
  return (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 text-left">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-[11px] font-normal text-muted-foreground">{hint}</span>
      </span>
    </>
  );
}

export function QuickActions() {
  const { composer } = useDashboardData();
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">Quick actions</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {/* Ledger entry opens the shared composer in a dialog, in place:
            the dashboard (URL, scroll, widgets) is never navigated away. */}
        <TransactionComposerDialog
          trigger={
            <span className="flex h-auto w-full items-center justify-start gap-3 rounded-lg border border-border bg-background px-3 py-2.5 shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground">
              <ActionContent
                icon={ArrowLeftRightIcon}
                label="Ledger entry"
                hint="Income, expense, or transfer"
              />
            </span>
          }
          title="New transaction"
          accounts={composer.accounts}
          categories={composer.categories}
          tags={composer.tags}
          today={composer.today}
          idPrefix="dashboard-txn"
        />
        {linkActions.map((action) => (
          <Button
            key={action.href}
            variant="outline"
            className="h-auto justify-start gap-3 px-3 py-2.5"
            render={<Link href={action.href} />}
          >
            <ActionContent icon={action.icon} label={action.label} hint={action.hint} />
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
