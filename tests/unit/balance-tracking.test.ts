import { describe, it, expect } from "vitest";
import { defaultBalanceTracking, isValuationTracked } from "@/server/authorization/access";

describe("balance tracking helpers", () => {
  it("defaults by type: valuation-driven types track valuations, others transactions", () => {
    expect(defaultBalanceTracking("other_asset")).toBe("valuation");
    expect(defaultBalanceTracking("other_liability")).toBe("valuation");
    expect(defaultBalanceTracking("depository")).toBe("transactions");
    expect(defaultBalanceTracking("credit_card")).toBe("transactions");
  });

  it("honors the per-account mode for other asset / liability accounts", () => {
    expect(isValuationTracked({ type: "other_asset", balanceTracking: "valuation" })).toBe(true);
    expect(isValuationTracked({ type: "other_asset", balanceTracking: "transactions" })).toBe(
      false
    );
    expect(isValuationTracked({ type: "other_liability", balanceTracking: "transactions" })).toBe(
      false
    );
  });

  it("falls back to the type default when the column is missing", () => {
    expect(isValuationTracked({ type: "other_asset", balanceTracking: null })).toBe(true);
    expect(isValuationTracked({ type: "other_asset" })).toBe(true);
  });

  it("depository and credit card accounts are always transaction-tracked", () => {
    expect(isValuationTracked({ type: "depository", balanceTracking: "valuation" })).toBe(false);
    expect(isValuationTracked({ type: "credit_card", balanceTracking: "valuation" })).toBe(false);
  });
});
