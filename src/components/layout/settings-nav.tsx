"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const sections = [
  {
    label: "Account",
    links: [
      { href: "/settings", label: "Profile & preferences", exact: true },
      { href: "/settings/security", label: "Security" },
      { href: "/settings/api-keys", label: "API keys & Shortcuts" }
    ]
  },
  {
    label: "Transactions",
    links: [
      { href: "/settings/categories", label: "Categories" },
      { href: "/settings/tags", label: "Tags" },
      { href: "/settings/recurring", label: "Recurring transactions" },
      { href: "/settings/meroshare", label: "MeroShare" }
    ]
  },
  {
    label: "Family",
    links: [
      { href: "/settings/members", label: "Members" },
      { href: "/settings/exchange-rates", label: "Exchange rates" },
      { href: "/settings/data", label: "Your data" }
    ]
  }
] as const;

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <aside className="lg:sticky lg:top-20 lg:self-start">
      <nav aria-label="Settings" className="space-y-5">
        {sections.map((section) => (
          <section key={section.label}>
            <div className="mb-2 flex items-center gap-2 px-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {section.label}
              </h2>
              <span className="h-px flex-1 bg-border" aria-hidden />
            </div>
            <ul className="space-y-0.5">
              {section.links.map((link) => {
                const active =
                  "exact" in link && link.exact
                    ? pathname === link.href
                    : pathname === link.href || pathname.startsWith(`${link.href}/`);
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "block rounded-lg px-3 py-2 text-sm transition-colors",
                        active
                          ? "bg-card text-foreground shadow-sm ring-1 ring-foreground/10"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      {link.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
    </aside>
  );
}
