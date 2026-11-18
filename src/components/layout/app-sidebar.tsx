"use client";

import Link from "next/link";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from "@/components/ui/sidebar";
import { NavMain } from "@/components/layout/nav-main";
import { NavSecondary } from "@/components/layout/nav-secondary";
import { NavUser } from "@/components/layout/nav-user";
import { fmtMoney } from "@/lib/format";
import {
  ArrowLeftRightIcon,
  CalculatorIcon,
  ChartAreaIcon,
  LandmarkIcon,
  LayoutDashboardIcon,
  MessageCircleIcon,
  PiggyBankIcon,
  PlusIcon,
  SettingsIcon,
  ShieldIcon,
  TargetIcon,
  TriangleAlertIcon,
  WalletIcon
} from "lucide-react";

export type NavAccount = {
  id: string;
  name: string;
  type: string;
  displayBalanceMinor: number;
  currency: string;
};

export function AppSidebar({
  user,
  email,
  family,
  privacy,
  accounts,
  netWorthMinor,
  fxIssues,
  currency,
  showAdmin,
  signOut,
  togglePrivacy,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: string;
  email: string;
  family: string;
  privacy: boolean;
  accounts: NavAccount[];
  netWorthMinor: number;
  fxIssues: { base: string; quote: string }[];
  currency: string;
  showAdmin: boolean;
  signOut: () => Promise<void>;
  togglePrivacy: () => Promise<void>;
}) {
  const cashAccounts = accounts.filter((account) => account.type === "depository");

  const secondary = [
    { title: "Settings", url: "/settings", icon: <SettingsIcon /> },
    ...(showAdmin ? [{ title: "Admin", url: "/admin", icon: <ShieldIcon /> }] : [])
  ];

  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <LandmarkIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Meridian</span>
                <span className="truncate text-xs text-muted-foreground">{family}</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <div className="mx-2 mb-1 rounded-xl bg-sidebar-accent px-3 py-2.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Net worth
          </p>
          <p className="tabular-nums text-sm font-semibold">
            {privacy ? "••••••" : fmtMoney(netWorthMinor, currency)}
          </p>
          {fxIssues.length > 0 ? (
            <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-warning">
              <TriangleAlertIcon className="mt-px size-3 shrink-0" aria-hidden />
              <span>
                Incomplete — no rate for{" "}
                {fxIssues.map((issue) => `${issue.base} → ${issue.quote}`).join(", ")}, so those
                amounts are excluded.{" "}
                <Link href="/settings/exchange-rates" className="underline underline-offset-2">
                  Add rates
                </Link>
              </span>
            </p>
          ) : null}
        </div>
        <NavMain
          label="Daily"
          items={[
            { title: "Overview", url: "/", icon: <LayoutDashboardIcon />, exact: true },
            { title: "Accounts", url: "/accounts", icon: <WalletIcon /> },
            { title: "Transactions", url: "/transactions", icon: <ArrowLeftRightIcon /> },
            { title: "Quick add", url: "/quick-add", icon: <PlusIcon /> }
          ]}
        />
        <NavMain
          label="Insights"
          items={[
            { title: "Reports", url: "/reports", icon: <ChartAreaIcon /> },
            { title: "SSIS", url: "/insights/ssis", icon: <LandmarkIcon /> },
            { title: "Budgets", url: "/budgets", icon: <TargetIcon /> },
            { title: "Goals", url: "/goals", icon: <PiggyBankIcon /> },
            { title: "Debt payoff", url: "/debts", icon: <CalculatorIcon /> },
            { title: "Assistant", url: "/chat", icon: <MessageCircleIcon /> }
          ]}
        />
        {cashAccounts.length > 0 ? (
          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Cash accounts</SidebarGroupLabel>
            <SidebarMenu>
              {cashAccounts.slice(0, 12).map((account) => (
                <SidebarMenuItem key={account.id}>
                  <SidebarMenuButton size="sm" render={<Link href={`/accounts/${account.id}`} />}>
                    <span className="min-w-0 truncate">{account.name}</span>
                    <span className="ml-auto tabular-nums text-[10px] text-muted-foreground">
                      {privacy ? "••••" : fmtMoney(account.displayBalanceMinor, account.currency)}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton size="sm" render={<Link href="/accounts/new" />}>
                  <PlusIcon />
                  <span>Add account</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        ) : null}
        <NavSecondary items={secondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          user={user}
          email={email}
          family={family}
          privacy={privacy}
          showAdmin={showAdmin}
          signOut={signOut}
          togglePrivacy={togglePrivacy}
        />
      </SidebarFooter>
    </Sidebar>
  );
}
