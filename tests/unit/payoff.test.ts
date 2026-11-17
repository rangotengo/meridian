import { describe, expect, it } from "vitest";
import {
  addMonthsToKey,
  bpsToPercentString,
  parsePercentToBps,
  planPayoff,
  simulatePayoff
} from "@/lib/payoff";

describe("simulatePayoff", () => {
  it("pays a zero-rate loan off in balance / payment months with no interest", () => {
    const plan = simulatePayoff({
      balanceMinor: 1_200_000,
      annualRateBps: null,
      monthlyPaymentMinor: 100_000,
      fromMonth: "2026-11"
    });
    expect(plan).toEqual({
      payoffMonths: 12,
      payoffMonth: "2027-11",
      totalInterestMinor: 0,
      totalPaidMinor: 1_200_000
    });
  });

  it("charges monthly-compounded interest and lands on the final payment month", () => {
    // 1,200,000 minor at 12% APR, 100,000/month: 13 payments, 84,779 interest.
    const plan = simulatePayoff({
      balanceMinor: 1_200_000,
      annualRateBps: 1200,
      monthlyPaymentMinor: 100_000,
      fromMonth: "2026-11"
    });
    expect(plan).toEqual({
      payoffMonths: 13,
      payoffMonth: "2027-12",
      totalInterestMinor: 84_779,
      totalPaidMinor: 1_284_779
    });
  });

  it("reports never when the payment does not cover one month of interest", () => {
    const plan = simulatePayoff({
      balanceMinor: 1_200_000,
      annualRateBps: 1200,
      monthlyPaymentMinor: 10_000,
      fromMonth: "2026-11"
    });
    expect(plan).toEqual({
      payoffMonths: null,
      payoffMonth: null,
      totalInterestMinor: null,
      totalPaidMinor: null
    });
  });

  it("reports never when the payment exactly equals one month of interest", () => {
    const plan = simulatePayoff({
      balanceMinor: 1_200_000,
      annualRateBps: 1200,
      monthlyPaymentMinor: 12_000,
      fromMonth: "2026-11"
    });
    expect(plan.payoffMonths).toBeNull();
  });

  it("a zero balance is already paid off in the starting month", () => {
    const plan = simulatePayoff({
      balanceMinor: 0,
      annualRateBps: 1200,
      monthlyPaymentMinor: 100_000,
      fromMonth: "2026-11"
    });
    expect(plan).toEqual({
      payoffMonths: 0,
      payoffMonth: "2026-11",
      totalInterestMinor: 0,
      totalPaidMinor: 0
    });
  });

  it("rejects invalid inputs instead of planning on them", () => {
    const base = {
      balanceMinor: 1_200_000,
      annualRateBps: 1200,
      monthlyPaymentMinor: 100_000,
      fromMonth: "2026-11"
    };
    expect(() => simulatePayoff({ ...base, monthlyPaymentMinor: 0 })).toThrow();
    expect(() => simulatePayoff({ ...base, balanceMinor: -1 })).toThrow();
    expect(() => simulatePayoff({ ...base, annualRateBps: 100001 })).toThrow();
    expect(() => simulatePayoff({ ...base, fromMonth: "2026-13" })).toThrow();
  });
});

describe("planPayoff", () => {
  it("extra payments save interest and months", () => {
    // Base: 13 months / 84,779 interest. With +50,000/month: 9 months / 57,143.
    const comparison = planPayoff({
      balanceMinor: 1_200_000,
      annualRateBps: 1200,
      monthlyPaymentMinor: 100_000,
      extraMonthlyPaymentMinor: 50_000,
      fromMonth: "2026-11"
    });
    expect(comparison.base.payoffMonths).toBe(13);
    expect(comparison.withExtra).toEqual({
      payoffMonths: 9,
      payoffMonth: "2027-08",
      totalInterestMinor: 57_143,
      totalPaidMinor: 1_257_143
    });
    expect(comparison.interestSavedMinor).toBe(27_636);
    expect(comparison.monthsSaved).toBe(4);
  });

  it("zero extra returns the base plan unchanged with zero savings", () => {
    const comparison = planPayoff({
      balanceMinor: 1_200_000,
      annualRateBps: 1200,
      monthlyPaymentMinor: 100_000,
      extraMonthlyPaymentMinor: 0,
      fromMonth: "2026-11"
    });
    expect(comparison.withExtra).toEqual(comparison.base);
    expect(comparison.interestSavedMinor).toBe(0);
    expect(comparison.monthsSaved).toBe(0);
  });

  it("savings are null when the base plan never pays off", () => {
    const comparison = planPayoff({
      balanceMinor: 1_200_000,
      annualRateBps: 1200,
      monthlyPaymentMinor: 10_000,
      extraMonthlyPaymentMinor: 100_000,
      fromMonth: "2026-11"
    });
    expect(comparison.base.payoffMonths).toBeNull();
    expect(comparison.withExtra.payoffMonths).not.toBeNull();
    expect(comparison.interestSavedMinor).toBeNull();
    expect(comparison.monthsSaved).toBeNull();
  });

  it("rejects a negative extra payment", () => {
    expect(() =>
      planPayoff({
        balanceMinor: 1_200_000,
        annualRateBps: 1200,
        monthlyPaymentMinor: 100_000,
        extraMonthlyPaymentMinor: -1,
        fromMonth: "2026-11"
      })
    ).toThrow();
  });
});

describe("rate helpers", () => {
  it("formats basis points as a percent string", () => {
    expect(bpsToPercentString(1250)).toBe("12.50");
    expect(bpsToPercentString(0)).toBe("0.00");
  });

  it("parses typed percents to basis points", () => {
    expect(parsePercentToBps("12.5")).toBe(1250);
    expect(parsePercentToBps("12.50%")).toBe(1250);
    expect(parsePercentToBps("")).toBeNull();
    expect(parsePercentToBps("abc")).toBeNull();
    expect(parsePercentToBps("-1")).toBeNull();
    expect(parsePercentToBps("1001")).toBeNull();
  });

  it("adds months across year boundaries", () => {
    expect(addMonthsToKey("2026-11", 13)).toBe("2027-12");
    expect(addMonthsToKey("2026-11", 0)).toBe("2026-11");
  });
});
