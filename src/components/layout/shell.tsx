"use client";

import { AppSidebar, type NavAccount } from "@/components/layout/app-sidebar";
import { CommandPalette } from "@/components/layout/command-palette";
import { DynamicBreadcrumb } from "@/components/layout/dynamic-breadcrumb";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { PrivacyProvider } from "@/components/layout/privacy-context";

export type { NavAccount };

export function Shell({
  user,
  email,
  family,
  privacy,
  assets,
  liabilities,
  netWorthMinor,
  fxIssues,
  currency,
  children,
  signOut,
  togglePrivacy,
  showAdmin
}: {
  user: string;
  email: string;
  family: string;
  privacy: boolean;
  assets: NavAccount[];
  liabilities: NavAccount[];
  netWorthMinor: number;
  fxIssues: { base: string; quote: string }[];
  currency: string;
  children: React.ReactNode;
  signOut: () => Promise<void>;
  togglePrivacy: () => Promise<void>;
  showAdmin: boolean;
}) {
  const accounts = [...assets, ...liabilities];

  return (
    <SidebarProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <AppSidebar
        user={user}
        email={email}
        family={family}
        privacy={privacy}
        accounts={accounts}
        netWorthMinor={netWorthMinor}
        fxIssues={fxIssues}
        currency={currency}
        showAdmin={showAdmin}
        signOut={signOut}
        togglePrivacy={togglePrivacy}
      />
      <SidebarInset data-privacy={privacy ? "true" : "false"}>
        <header className="no-print flex h-16 shrink-0 items-center gap-2">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-vertical:h-4 data-vertical:self-auto"
            />
            <DynamicBreadcrumb />
          </div>
          <div className="ml-auto flex items-center gap-1 pr-4">
            <form action={togglePrivacy}>
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                className="size-8 rounded-full"
                aria-pressed={privacy}
                title="Privacy mode hides all monetary amounts"
              >
                {privacy ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
                <span className="sr-only">Toggle privacy mode</span>
              </Button>
            </form>
            <kbd className="pointer-events-none hidden h-6 select-none items-center gap-1 rounded border bg-muted px-2 font-mono text-[10px] font-medium text-muted-foreground sm:flex">
              <span className="text-xs">⌘</span>K
            </kbd>
            <ThemeToggle />
          </div>
        </header>
        <CommandPalette accounts={accounts} privacy={privacy} />
        <main id="main" className="flex flex-1 flex-col">
          <PrivacyProvider value={privacy}>
            <div className="flex flex-1 flex-col gap-4 p-4 pt-0 pb-8">{children}</div>
          </PrivacyProvider>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
