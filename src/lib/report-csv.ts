import { minorToDecimal } from "./money";
import { fmtMonth } from "./format";

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export type IncomeExpenseRow = {
  monthKey: string;
  incomeMinor: number;
  expenseMinor: number;
};

/** One row per month: Month, Income, Spending, Net (major units). */
export function incomeExpenseCsv(flows: IncomeExpenseRow[], currency: string): string {
  const lines = [`Month,Income (${currency}),Spending (${currency}),Net (${currency})`];
  for (const flow of flows) {
    lines.push(
      [
        csvCell(fmtMonth(flow.monthKey)),
        minorToDecimal(flow.incomeMinor, currency),
        minorToDecimal(flow.expenseMinor, currency),
        minorToDecimal(flow.incomeMinor - flow.expenseMinor, currency)
      ].join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

export type CategorySpendingRow = { name: string; totalMinor: number };

/** One row per category: Category, Spending (major units). */
export function categorySpendingCsv(categories: CategorySpendingRow[], currency: string): string {
  const lines = [`Category,Spending (${currency})`];
  for (const category of categories) {
    lines.push([csvCell(category.name), minorToDecimal(category.totalMinor, currency)].join(","));
  }
  return `${lines.join("\n")}\n`;
}
