/**
 * Debt payoff simulation.
 *
 * Pure functions with no imports, so the same code runs in the browser
 * (the planner is interactive) and in unit tests. All money is integer
 * minor units; the interest rate is annual basis points (1200 = 12.00%).
 *
 * Assumptions, stated in the UI as well:
 * - Monthly compounding: interest accrues once a month on the balance at
 *   the start of that month, at annual rate / 12.
 * - The monthly payment (plus any extra) is applied at the end of the
 *   month, first to that month's interest and the rest to principal.
 * - The monthly payment stays fixed; the final payment is whatever is
 *   left, never more than the remaining balance plus interest.
 * - A NULL rate means "unknown" and plans with zero interest; the UI says
 *   so rather than pretending the loan is interest-free.
 * - A plan that cannot pay the loan off within 50 years (600 payments) —
 *   including when the payment does not even cover one month's interest —
 *   reports payoffMonths: null instead of a meaningless date.
 */

export const MAX_PAYOFF_MONTHS = 600;
export const MAX_RATE_BPS = 100000; // 1000% APR.

export type PayoffPlan = {
  /** Months until the final payment, or null when the loan never pays off. */
  payoffMonths: number | null;
  /** YYYY-MM of the final payment, relative to fromMonth; null when never. */
  payoffMonth: string | null;
  /** Total interest paid over the plan; null when the loan never pays off. */
  totalInterestMinor: number | null;
  /** Total paid over the plan (principal + interest); null when never. */
  totalPaidMinor: number | null;
};

export type PayoffComparison = {
  base: PayoffPlan;
  withExtra: PayoffPlan;
  /** Interest saved by the extra payment; null when either plan never pays off. */
  interestSavedMinor: number | null;
  /** Months saved by the extra payment; null when either plan never pays off. */
  monthsSaved: number | null;
};

function assertPayoffInputs(
  balanceMinor: number,
  annualRateBps: number | null,
  monthlyPaymentMinor: number
) {
  if (!Number.isInteger(balanceMinor) || balanceMinor < 0) {
    throw new Error("Balance owed must be a non-negative integer in minor units.");
  }
  if (
    annualRateBps !== null &&
    (!Number.isInteger(annualRateBps) || annualRateBps < 0 || annualRateBps > MAX_RATE_BPS)
  ) {
    throw new Error("Interest rate must be between 0% and 1000%.");
  }
  if (!Number.isInteger(monthlyPaymentMinor) || monthlyPaymentMinor <= 0) {
    throw new Error("Monthly payment must be a positive integer in minor units.");
  }
}

function assertMonthKey(monthKey: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
    throw new Error("Month must be YYYY-MM.");
  }
}

/** Add months to a YYYY-MM key, e.g. addMonthsToKey("2026-11", 14) === "2028-01". */
export function addMonthsToKey(monthKey: string, months: number): string {
  assertMonthKey(monthKey);
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const d = new Date(Date.UTC(year, month - 1 + months, 1));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return y + "-" + (m < 10 ? "0" + m : String(m));
}

/** Monthly interest on a balance, rounded half-up to the nearest minor unit. */
function monthlyInterestMinor(balanceMinor: number, annualRateBps: number): number {
  // BigInt keeps this exact: balance * bps can exceed Number.MAX_SAFE_INTEGER.
  const interest = (BigInt(balanceMinor) * BigInt(annualRateBps) + 60_000n) / 120_000n;
  return Number(interest);
}

export function simulatePayoff(input: {
  balanceMinor: number;
  annualRateBps: number | null;
  monthlyPaymentMinor: number;
  fromMonth: string;
}): PayoffPlan {
  const { balanceMinor, annualRateBps, monthlyPaymentMinor, fromMonth } = input;
  assertPayoffInputs(balanceMinor, annualRateBps, monthlyPaymentMinor);
  assertMonthKey(fromMonth);
  const rateBps = annualRateBps ?? 0;

  if (balanceMinor === 0) {
    return { payoffMonths: 0, payoffMonth: fromMonth, totalInterestMinor: 0, totalPaidMinor: 0 };
  }

  let balance = balanceMinor;
  let totalInterest = 0;
  let totalPaid = 0;
  for (let month = 1; month <= MAX_PAYOFF_MONTHS; month++) {
    const interest = monthlyInterestMinor(balance, rateBps);
    balance += interest;
    totalInterest += interest;
    const payment = Math.min(balance, monthlyPaymentMinor);
    balance -= payment;
    totalPaid += payment;
    if (balance === 0) {
      return {
        payoffMonths: month,
        payoffMonth: addMonthsToKey(fromMonth, month),
        totalInterestMinor: totalInterest,
        totalPaidMinor: totalPaid
      };
    }
  }
  return { payoffMonths: null, payoffMonth: null, totalInterestMinor: null, totalPaidMinor: null };
}

export function planPayoff(input: {
  balanceMinor: number;
  annualRateBps: number | null;
  monthlyPaymentMinor: number;
  extraMonthlyPaymentMinor: number;
  fromMonth: string;
}): PayoffComparison {
  const { balanceMinor, annualRateBps, monthlyPaymentMinor, extraMonthlyPaymentMinor, fromMonth } =
    input;
  if (!Number.isInteger(extraMonthlyPaymentMinor) || extraMonthlyPaymentMinor < 0) {
    throw new Error("Extra monthly payment must be a non-negative integer in minor units.");
  }
  const base = simulatePayoff({ balanceMinor, annualRateBps, monthlyPaymentMinor, fromMonth });
  const withExtra =
    extraMonthlyPaymentMinor === 0
      ? base
      : simulatePayoff({
          balanceMinor,
          annualRateBps,
          monthlyPaymentMinor: monthlyPaymentMinor + extraMonthlyPaymentMinor,
          fromMonth
        });
  const baseInterest = base.totalInterestMinor;
  const extraInterest = withExtra.totalInterestMinor;
  const baseMonths = base.payoffMonths;
  const extraMonths = withExtra.payoffMonths;
  const bothPayOff =
    baseMonths !== null && extraMonths !== null && baseInterest !== null && extraInterest !== null;
  return {
    base,
    withExtra,
    interestSavedMinor: bothPayOff ? baseInterest - extraInterest : null,
    monthsSaved: bothPayOff ? baseMonths - extraMonths : null
  };
}

/** 1250 -> "12.50". */
export function bpsToPercentString(bps: number): string {
  return (bps / 100).toFixed(2);
}

/**
 * Parse a user-typed percent ("12.5", "12.50%") to basis points.
 * Returns null for empty, non-numeric, negative, or > 1000% input.
 */
export function parsePercentToBps(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, "").trim();
  if (!cleaned) return null;
  const pct = Number(cleaned);
  if (!Number.isFinite(pct) || pct < 0 || pct > 1000) return null;
  return Math.round(pct * 100);
}
