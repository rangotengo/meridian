"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from "@/components/ui/command";
import {
  LayoutDashboardIcon,
  WalletIcon,
  ArrowLeftRightIcon,
  PlusIcon,
  ChartAreaIcon,
  TargetIcon,
  MessageCircleIcon,
  SettingsIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  SearchIcon,
  TagIcon,
  StoreIcon
} from "lucide-react";
import { applyTheme } from "@/lib/theme";
import { setThemePreferenceAction } from "@/server/actions/session-actions";
import { fmtMoney } from "@/lib/format";
import { resolvePaletteShortcut } from "@/lib/keyboard-shortcuts";
import type { NavAccount } from "@/components/layout/app-sidebar";

const pages = [
  { label: "Overview", icon: LayoutDashboardIcon, href: "/" },
  { label: "Accounts", icon: WalletIcon, href: "/accounts" },
  { label: "Transactions", icon: ArrowLeftRightIcon, href: "/transactions" },
  { label: "New transaction", icon: PlusIcon, href: "/transactions/new", shortcut: "N" },
  { label: "Quick add", icon: PlusIcon, href: "/quick-add", shortcut: "Q" },
  { label: "Reports", icon: ChartAreaIcon, href: "/reports" },
  { label: "Budgets", icon: TargetIcon, href: "/budgets" },
  { label: "Assistant", icon: MessageCircleIcon, href: "/chat" },
  { label: "Settings", icon: SettingsIcon, href: "/settings" }
];

/** Mirrors the sections in the settings nav so the palette finds every settings page. */
const settingsPages = [
  { label: "Profile & preferences", href: "/settings" },
  { label: "Security", href: "/settings/security" },
  { label: "API keys & Shortcuts", href: "/settings/api-keys" },
  { label: "Connected AI agents", href: "/settings/ai-agents" },
  { label: "Categories", href: "/settings/categories" },
  { label: "Tags", href: "/settings/tags" },
  { label: "Recurring transactions", href: "/settings/recurring" },
  { label: "MeroShare", href: "/settings/meroshare" },
  { label: "Members", href: "/settings/members" },
  { label: "Exchange rates", href: "/settings/exchange-rates" },
  { label: "Your data", href: "/settings/data" }
];

export type PaletteCategory = {
  id: string;
  name: string;
  parentName: string | null;
};

export function CommandPalette({
  accounts,
  categories,
  merchants,
  privacy
}: {
  accounts: NavAccount[];
  categories: PaletteCategory[];
  merchants: string[];
  privacy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const action = resolvePaletteShortcut({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        target: e.target
      });
      if (!action) return;
      e.preventDefault();
      if (action === "toggle-palette") setOpen((o) => !o);
      if (action === "new-transaction") router.push("/transactions/new");
      if (action === "quick-add") router.push("/quick-add");
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [router]);

  const run = useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command Palette"
      description="Search pages, accounts, categories, payees and settings"
    >
      <Command>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Pages">
            {pages.map((page) => (
              <CommandItem key={page.href} onSelect={() => run(() => router.push(page.href))}>
                <page.icon className="mr-2 size-4" />
                {page.label}
                {"shortcut" in page && page.shortcut ? (
                  <CommandShortcut>{page.shortcut}</CommandShortcut>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
          {accounts.length > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Accounts">
                {accounts.slice(0, 12).map((account) => (
                  <CommandItem
                    key={account.id}
                    onSelect={() => run(() => router.push(`/accounts/${account.id}`))}
                  >
                    <SearchIcon className="mr-2 size-4" />
                    {account.name}
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {privacy ? "•••••" : fmtMoney(account.displayBalanceMinor, account.currency)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : null}
          {categories.length > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Categories">
                {categories.slice(0, 12).map((category) => (
                  <CommandItem
                    key={category.id}
                    keywords={
                      category.parentName ? [category.name, category.parentName] : [category.name]
                    }
                    onSelect={() =>
                      run(() => router.push(`/transactions?category=${category.id}`))
                    }
                  >
                    <TagIcon className="mr-2 size-4" />
                    {category.parentName ? `${category.parentName} / ${category.name}` : category.name}
                    <span className="ml-auto text-xs text-muted-foreground">
                      Transactions
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : null}
          {merchants.length > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Payees">
                {merchants.slice(0, 12).map((merchant) => (
                  <CommandItem
                    key={merchant}
                    onSelect={() =>
                      run(() => router.push(`/transactions?q=${encodeURIComponent(merchant)}`))
                    }
                  >
                    <StoreIcon className="mr-2 size-4" />
                    {merchant}
                    <span className="ml-auto text-xs text-muted-foreground">
                      Transactions
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : null}
          <CommandSeparator />
          <CommandGroup heading="Settings">
            {settingsPages.map((page) => (
              <CommandItem
                key={page.href}
                keywords={[page.label, "settings"]}
                onSelect={() => run(() => router.push(page.href))}
              >
                <SettingsIcon className="mr-2 size-4" />
                {page.label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Theme">
            <CommandItem
              onSelect={() =>
                run(() => {
                  applyTheme("light");
                  void setThemePreferenceAction("light");
                })
              }
            >
              <SunIcon className="mr-2 size-4" />
              Light mode
            </CommandItem>
            <CommandItem
              onSelect={() =>
                run(() => {
                  applyTheme("dark");
                  void setThemePreferenceAction("dark");
                })
              }
            >
              <MoonIcon className="mr-2 size-4" />
              Dark mode
            </CommandItem>
            <CommandItem
              onSelect={() =>
                run(() => {
                  applyTheme("system");
                  void setThemePreferenceAction("system");
                })
              }
            >
              <MonitorIcon className="mr-2 size-4" />
              System theme
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
