"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeftRightIcon, MessageCircleIcon, PlusIcon, WalletIcon } from "lucide-react";
import { useDashboardData } from "@/components/finance/dashboard-data";
import { TransactionComposerDialog } from "@/components/finance/transaction-composer";
import { Dialog, useDialogClose } from "@/components/ds/dialog";
import { QuickAddForm } from "@/app/(app)/quick-add/form";

const linkActions = [
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

const actionTriggerClassName =
  "flex h-auto w-full items-center justify-start gap-3 rounded-lg border border-border bg-background px-3 py-2.5 shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground";

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

/**
 * Quick add hosted in a dialog on the dashboard, reusing the standalone
 * page's form and its non-redirecting action: a successful save refreshes
 * the dashboard in place and closes; cancelling writes nothing. The form
 * remounts on every open (keyed by an open counter fed by Dialog's
 * onOpen), so no stale state leaks between opens. The standalone
 * /quick-add page remains the sidebar's destination — only this
 * dashboard shortcut changed.
 */
function QuickAddDialog({
  accounts,
  categories,
  tags,
  today
}: {
  accounts: { id: string; name: string; currency: string }[];
  categories: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  today: string;
}) {
  const [openCount, setOpenCount] = useState(0);
  return (
    <Dialog
      trigger={
        <span className={actionTriggerClassName}>
          <ActionContent icon={PlusIcon} label="Quick add" hint="Capture a transaction fast" />
        </span>
      }
      title="Quick add"
      description="Record a transaction in seconds."
      onOpen={() => setOpenCount((c) => c + 1)}
    >
      <QuickAddDialogBody
        key={openCount}
        accounts={accounts}
        categories={categories}
        tags={tags}
        today={today}
      />
    </Dialog>
  );
}

function QuickAddDialogBody(props: {
  accounts: { id: string; name: string; currency: string }[];
  categories: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  today: string;
}) {
  const close = useDialogClose();
  const router = useRouter();
  const handleSaved = () => {
    router.refresh();
    close();
  };
  return <QuickAddForm {...props} onSaved={handleSaved} onCancel={close} />;
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
            <span className={actionTriggerClassName}>
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
        {/* Quick add also opens in place (its own compact form in a
            dialog); /quick-add itself stays the sidebar destination. */}
        <QuickAddDialog
          accounts={composer.accounts}
          categories={composer.categories}
          tags={composer.tags}
          today={composer.today}
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
