import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { loadActor, currentFamily } from "@/server/auth/context";
import { incomeExpenseSeries, spendingByCategory } from "@/server/domain/reports";
import { requireEmailVerification } from "@/lib/env";
import { monthKeyIn } from "@/lib/datetime";
import { resolveReportRange } from "@/lib/report-range";
import { incomeExpenseCsv, categorySpendingCsv } from "@/lib/report-csv";

export const dynamic = "force-dynamic";

function inWindow(monthKey: string, fromMonth: string, toMonth: string): boolean {
  return monthKey >= fromMonth && monthKey <= toMonth;
}

export async function GET(req: NextRequest) {
  const actor = await loadActor();
  if (!actor) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (requireEmailVerification() && !actor.emailVerified) {
    return NextResponse.json(
      { error: "forbidden", message: "Email verification is required to export data." },
      { status: 403 }
    );
  }
  const family = await currentFamily(actor);
  const params = req.nextUrl.searchParams;
  const report = params.get("report");
  if (report !== "income-expense" && report !== "spending-by-category") {
    return NextResponse.json({ error: "unknown report" }, { status: 400 });
  }

  const db = getDb();
  const range = resolveReportRange({
    period: params.get("period") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    currentMonth: monthKeyIn(family.timezone)
  });

  const today = new Date().toISOString().slice(0, 10);
  if (report === "income-expense") {
    const flowsResult = await incomeExpenseSeries(db, family, actor.userId, range.monthsBack);
    const flows = flowsResult.flows.filter((flow) =>
      inWindow(flow.monthKey, range.fromMonth, range.toMonth)
    );
    const csv = incomeExpenseCsv(flows, family.currency);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="meridian-report-income-expense-${today}.csv"`,
        "Cache-Control": "no-store"
      }
    });
  }

  const spendResult = await spendingByCategory(db, family, actor.userId, {
    from: range.from,
    to: range.to
  });
  const csv = categorySpendingCsv(spendResult.categories, family.currency);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="meridian-report-spending-by-category-${today}.csv"`,
      "Cache-Control": "no-store"
    }
  });
}
