"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  CalculatorIcon,
  ChartAreaIcon,
  PiggyBankIcon,
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
import { filterAndLimit, PALETTE_RESULT_LIMIT } from "@/lib/palette-filter";
import type { NavAccount } from "@/components/layout/app-sidebar";

const pages = [
  { label: "Overview", icon: LayoutDashboardIcon, href: "/" },
  { label: "Accounts", icon: WalletIcon, href: "/accounts" },
  { label: "Transactions", icon: ArrowLeftRightIcon, href: "/transactions" },
  { label: "New transaction", icon: PlusIcon, href: "/transactions/new", shortcut: "N" },
  { label: "Quick add", icon: PlusIcon, href: "/quick-add", shortcut: "Q" },
  { label: "Reports", icon: ChartAreaIcon, href: "/reports" },
  { label: "Budgets", icon: TargetIcon, href: "/budgets" },
  { label: "Goals", icon: PiggyBankIcon, href: "/goals" },
  { label: "Debt payoff", icon: CalculatorIcon, href: "/debts" },
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

const themeOptions = [
  {
    label: "Light mode",
    icon: SunIcon,
    apply: () => {
      applyTheme("light");
      void setThemePreferenceAction("light");
    }
  },
  {
    label: "Dark mode",
    icon: MoonIcon,
    apply: () => {
      applyTheme("dark");
      void setThemePreferenceAction("dark");
    }
  },
  {
    label: "System theme",
    icon: MonitorIcon,
    apply: () => {
      applyTheme("system");
      void setThemePreferenceAction("system");
    }
  }
];

export type PaletteCategory = {
  id: string;
  name: string;
  parentName: string | null;
};

/**
 * Shown under a group when filtering found more matches than the group
 * renders, so the user knows to refine the search instead of assuming
 * there are no more results.
 */
function MoreResults({ total }: { total: number }) {
  if (total <= PALETTE_RESULT_LIMIT) return null;
  return (
    <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
      Showing {PALETTE_RESULT_LIMIT} of {total} — refine your search to see more
    </p>
  );
}

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
  const [query, setQuery] = useState("");
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

  // Filter the FULL list first, then cap rendered rows. Slicing before
  // filtering hid every match past the cap (category 13 was never
  // findable). cmdk's own filtering is off (shouldFilter) so these
  // filtered lists are exactly what renders.
  const filtered = useMemo(
    () => ({
      pages: filterAndLimit(pages, query, (page) => [page.label]),
      accounts: filterAndLimit(accounts, query, (account) => [account.name]),
      categories: filterAndLimit(categories, query, (category) => [
        category.name,
        category.parentName
      ]),
      merchants: filterAndLimit(merchants, query, (merchant) => [merchant]),
      settings: filterAndLimit(settingsPages, query, (page) => [page.label, "settings"]),
      theme: filterAndLimit(themeOptions, query, (option) => [option.label])
    }),
    [accounts, categories, merchants, query]
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command Palette"
      description="Search pages, accounts, categories, payees and settings"
    >
      <Command shouldFilter={false}>
        <CommandInput
          placeholder="Type a command or search..."
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          {filtered.pages.total > 0 ? (
            <>
              <CommandGroup heading="Pages">
                {filtered.pages.shown.map((page) => (
                  <CommandItem key={page.href} onSelect={() => run(() => router.push(page.href))}>
                    <page.icon className="mr-2 size-4" />
                    {page.label}
                    {"shortcut" in page && page.shortcut ? (
                      <CommandShortcut>{page.shortcut}</CommandShortcut>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
              <MoreResults total={filtered.pages.total} />
            </>
          ) : null}
          {filtered.accounts.total > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Accounts">
                {filtered.accounts.shown.map((account) => (
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
              <MoreResults total={filtered.accounts.total} />
            </>
          ) : null}
          {filtered.categories.total > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Categories">
                {filtered.categories.shown.map((category) => (
                  <CommandItem
                    key={category.id}
                    keywords={
                      category.parentName ? [category.name, category.parentName] : [category.name]
                    }
                    onSelect={() => run(() => router.push(`/transactions?category=${category.id}`))}
                  >
                    <TagIcon className="mr-2 size-4" />
                    {category.parentName
                      ? `${category.parentName} / ${category.name}`
                      : category.name}
                    <span className="ml-auto text-xs text-muted-foreground">Transactions</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <MoreResults total={filtered.categories.total} />
            </>
          ) : null}
          {filtered.merchants.total > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Payees">
                {filtered.merchants.shown.map((merchant) => (
                  <CommandItem
                    key={merchant}
                    onSelect={() =>
                      run(() => router.push(`/transactions?q=${encodeURIComponent(merchant)}`))
                    }
                  >
                    <StoreIcon className="mr-2 size-4" />
                    {merchant}
                    <span className="ml-auto text-xs text-muted-foreground">Transactions</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <MoreResults total={filtered.merchants.total} />
            </>
          ) : null}
          {filtered.settings.total > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Settings">
                {filtered.settings.shown.map((page) => (
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
              <MoreResults total={filtered.settings.total} />
            </>
          ) : null}
          {filtered.theme.total > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Theme">
                {filtered.theme.shown.map((option) => (
                  <CommandItem key={option.label} onSelect={() => run(option.apply)}>
                    <option.icon className="mr-2 size-4" />
                    {option.label}
                  </CommandItem>
                ))}
              </CommandGroup>
              <MoreResults total={filtered.theme.total} />
            </>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
