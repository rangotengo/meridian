"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb";

const labelMap: Record<string, string> = {
  accounts: "Accounts",
  transactions: "Transactions",
  budgets: "Budgets",
  goals: "Goals",
  debts: "Debt payoff",
  reports: "Reports",
  chat: "Assistant",
  settings: "Settings",
  "quick-add": "Quick add",
  "import-sms": "Import SMS",
  new: "New",
  categories: "Categories",
  tags: "Tags",
  recurring: "Recurring",
  meroshare: "MeroShare",
  members: "Members",
  data: "Data",
  security: "Security",
  admin: "Admin",
  insights: "Insights",
  ssis: "SSIS",
  "api-keys": "API keys",
  "ai-agents": "AI agents",
  "exchange-rates": "Exchange rates"
};

// A UUID (or other id) segment is not a readable label: name it after its
// parent route instead of showing a truncated id.
const idParentLabel: Record<string, string> = {
  accounts: "Account",
  transactions: "Transaction"
};

const UUID_LIKE = /^[0-9a-f-]{8,}$/i;

export function DynamicBreadcrumb() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>Overview</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {segments.map((segment, index) => {
          const href = "/" + segments.slice(0, index + 1).join("/");
          const mapped = labelMap[segment];
          const idLabel =
            !mapped && UUID_LIKE.test(segment)
              ? (idParentLabel[segments[index - 1] ?? ""] ?? "Detail")
              : undefined;
          const label = mapped ?? idLabel ?? segment;
          const isLast = index === segments.length - 1;

          return (
            <React.Fragment key={href}>
              <BreadcrumbItem
                className={index === 0 && segments.length > 1 ? "hidden md:inline-flex" : undefined}
              >
                {isLast ? (
                  <BreadcrumbPage>{label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link href={href} />}>{label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && (
                <BreadcrumbSeparator
                  className={index === 0 ? "hidden md:inline-flex" : undefined}
                />
              )}
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
