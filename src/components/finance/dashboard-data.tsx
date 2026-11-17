"use client";

import { createContext, useContext } from "react";

import type { GoalProgress } from "@/server/domain/goals";

export type DashboardAccount = {
  id: string;
  name: string;
  type: string;
  displayBalanceMinor: number;
  currency: string;
  institution: string | null;
  status: string;
};

export type DashboardEntry = {
  id: string;
  date: string;
  name: string;
  amountMinor: number;
  currency: string;
  accountName: string;
  transferId: string | null;
};

export type HealthFactor = {
  id: string;
  label: string;
  score: number;
  status: "excellent" | "good" | "fair" | "poor";
  description: string;
};

export type DashboardBill = {
  seriesId: string;
  name: string;
  amountMinor: number;
  currency: string;
  accountName: string;
  dueDate: string;
  status: "missed" | "due-soon" | "upcoming";
  daysUntilDue: number;
};

export type DashboardData = {
  greeting: string;
  dateLabel: string;
  currency: string;
  locale: string;
  privacy: boolean;
  netWorthMinor: number;
  assetsMinor: number;
  liabilitiesMinor: number;
  incomeThisMonthMinor: number;
  expenseThisMonthMinor: number;
  series: { date: string; valueMinor: number }[];
  flows: { monthKey: string; incomeMinor: number; expenseMinor: number }[];
  topCategories: { name: string; totalMinor: number }[];
  recent: DashboardEntry[];
  accounts: DashboardAccount[];
  /** Data for the in-place transaction composer (Quick actions dialog). */
  composer: {
    accounts: { id: string; name: string; currency: string }[];
    categories: { id: string; name: string }[];
    tags: { id: string; name: string }[];
    today: string;
  };
  /** Active goals with live progress, for the Goals widget. */
  goals: GoalProgress[];
  budgetOverall: {
    limitMinor: number;
    spentMinor: number;
    remainingMinor: number;
    pct: number;
  } | null;
  bills: {
    missed: DashboardBill[];
    dueSoon: DashboardBill[];
    upcoming: DashboardBill[];
  };
  fx: {
    /** True when some amounts were excluded because no rate exists. */
    incomplete: boolean;
    /** Currency pairs with no usable rate; their amounts are excluded. */
    issues: { base: string; quote: string; date: string }[];
    /** Rates totals were converted with, with quoted-on dates. */
    rates: { base: string; quote: string; rate: string; quotedOn: string; stale: boolean }[];
  };
  health: {
    overall: number;
    trend: "up" | "down";
    trendDelta: number;
    factors: HealthFactor[];
    insufficientData?: boolean;
  };
};

const DashboardDataContext = createContext<DashboardData | null>(null);

export function DashboardDataProvider({
  data,
  children
}: {
  data: DashboardData;
  children: React.ReactNode;
}) {
  return <DashboardDataContext.Provider value={data}>{children}</DashboardDataContext.Provider>;
}

export function useDashboardData(): DashboardData {
  const ctx = useContext(DashboardDataContext);
  if (!ctx) {
    throw new Error("useDashboardData must be used inside a DashboardDataProvider");
  }
  return ctx;
}
