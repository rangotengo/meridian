import { describe, expect, it } from "vitest";
import {
  buildSsisSeries,
  computeSsisNavStats,
  computeSsisSummary,
  extractSsisSnapshot,
  maskBoAccountNo,
  parseDecimalScaled,
  parseUnits,
  resolveCurrentNav
} from "@/server/domain/ssis";
import { buildSsisPayload, SSIS_PII } from "../fixtures/ssis-snapshot";

describe("SSIS payload extraction (whitelist)", () => {
  it("extracts only whitelisted fields and drops every PII value", () => {
    const extracted = extractSsisSnapshot(buildSsisPayload());
    expect(extracted.purchases).toHaveLength(3);
    expect(extracted.statement).toHaveLength(2);
    expect(extracted.navHistory).toHaveLength(4);
    expect(extracted.holderName).toBe("Test Holder");
    const serialized = JSON.stringify(extracted);
    for (const pii of Object.values(SSIS_PII)) {
      expect(serialized).not.toContain(pii);
    }
    expect(Object.keys(extracted.purchases[0]!).sort()).toEqual(
      [
        "amountMinor",
        "applyDate",
        "isSip",
        "navDate",
        "purchaseNavMinor",
        "requestNo",
        "schemeName",
        "status",
        "units"
      ].sort()
    );
  });

  it("parses the fixture rows into minor units and canonical unit text", () => {
    const extracted = extractSsisSnapshot(buildSsisPayload());
    const first = extracted.purchases.find((p) => p.requestNo === "1001")!;
    expect(first).toMatchObject({
      applyDate: "2024-01-15",
      units: "100.25",
      amountMinor: 100250,
      status: "VERIFIED",
      purchaseNavMinor: 1000,
      navDate: "2024-01-15",
      isSip: true
    });
    const third = extracted.purchases.find((p) => p.requestNo === "1003")!;
    expect(third.units).toBe("25.5");
    expect(third.amountMinor).toBe(26010);
    expect(third.isSip).toBe(false);
    expect(third.schemeName).toBeNull();

    const t1 = extracted.statement.find((s) => s.transNo === "T1")!;
    expect(t1).toMatchObject({
      amountCrMinor: 100250,
      amountDrMinor: 0, // "-" means no debit
      units: "100.25",
      appliedNavMinor: 1000,
      payment: "E-Sewa",
      otherChargesMinor: 500,
      sebonFeeMinor: 200,
      sipRegNo: "SIP0001"
    });
    const t2 = extracted.statement.find((s) => s.transNo === "T2")!;
    expect(t2.units).toBeNull();
    expect(t2.appliedNavMinor).toBeNull();
    expect(t2.amountDrMinor).toBe(51000);
    expect(t2.otherChargesMinor).toBe(0);
  });

  it("counts malformed rows as skipped instead of failing", () => {
    const extracted = extractSsisSnapshot(buildSsisPayload());
    // 2 malformed purchases + 1 malformed statement row in the fixture.
    expect(extracted.skipped).toBe(3);
  });

  it("dedupes by REQUEST_NO / trans_no with last-wins, like the standalone", () => {
    const payload = buildSsisPayload() as [{ unitPurchase: Record<string, unknown>[] }];
    payload[0].unitPurchase.push({
      ...payload[0].unitPurchase[1],
      REQUEST_NO: 1002,
      AMOUNT: "999.99"
    });
    const extracted = extractSsisSnapshot(payload);
    const matches = extracted.purchases.filter((p) => p.requestNo === "1002");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.amountMinor).toBe(99999);
  });

  it("accepts navData.ResponseData as a bare object as well as an array", () => {
    const payload = buildSsisPayload() as [{ navData: Record<string, unknown> }];
    payload[0].navData = {
      ResponseData: { Scheme_code: "001", nav_date: "2024-03-20", nav_value: "11.50" }
    };
    const extracted = extractSsisSnapshot(payload);
    expect(extracted.navDataNav).toEqual({ navMinor: 1150, navDate: "2024-03-20" });
  });

  it("rejects payloads that are not SSIS snapshots", () => {
    expect(() => extractSsisSnapshot(null)).toThrow(/not an SSIS snapshot/);
    expect(() => extractSsisSnapshot([])).toThrow(/not an SSIS snapshot/);
    expect(() => extractSsisSnapshot([{ unitPurchase: [] }])).toThrow(
      /missing one of its datasets/
    );
  });
});

describe("SSIS decimal parsing", () => {
  it("parses strings, numbers, thousands separators and blanks defensively", () => {
    expect(parseDecimalScaled("1,234.50", 2)).toBe(123450n);
    expect(parseDecimalScaled(249.37, 4)).toBe(2493700n);
    expect(parseDecimalScaled("-", 2)).toBeNull();
    expect(parseDecimalScaled("", 2)).toBeNull();
    expect(parseDecimalScaled("abc", 2)).toBeNull();
    expect(parseDecimalScaled(null, 2)).toBeNull();
    expect(parseDecimalScaled("10.005", 2)).toBe(1001n); // half-up at 2dp
    expect(parseUnits("100.2500")!.text).toBe("100.25");
    expect(parseUnits(50)!.text).toBe("50");
  });
});

describe("SSIS summary math (mirrors the standalone dashboard)", () => {
  const extracted = extractSsisSnapshot(buildSsisPayload());

  it("sums units and invested, values at the latest non-future NAV", () => {
    const summary = computeSsisSummary({
      purchases: extracted.purchases,
      navHistory: extracted.navHistory,
      stateNav: extracted.navDataNav,
      today: "2024-04-01"
    });
    expect(summary.totalUnits).toBe("175.75");
    expect(summary.totalInvestedMinor).toBe(177260);
    // 2024-03-31 history point (11.00) wins over the future point and navData.
    expect(summary.currentNavMinor).toBe(1100);
    expect(summary.currentNavDate).toBe("2024-03-31");
    expect(summary.currentValueMinor).toBe(193325);
    expect(summary.profitMinor).toBe(16065);
    expect(summary.returnPercent).toBe(9.06);
  });

  it("falls back to the GetNAV value when no NAV history is usable", () => {
    const nav = resolveCurrentNav([], { navMinor: 1150, navDate: "2024-03-20" }, "2024-04-01");
    expect(nav).toEqual({ navMinor: 1150, navDate: "2024-03-20" });
    const summary = computeSsisSummary({
      purchases: extracted.purchases,
      navHistory: [],
      stateNav: extracted.navDataNav,
      today: "2024-04-01"
    });
    expect(summary.currentNavMinor).toBe(1150);
    expect(summary.currentValueMinor).toBe(202113); // 175.75 × 11.50, half-up
  });

  it("has no current value without any NAV", () => {
    const summary = computeSsisSummary({
      purchases: extracted.purchases,
      navHistory: [],
      stateNav: null,
      today: "2024-04-01"
    });
    expect(summary.currentValueMinor).toBeNull();
    expect(summary.profitMinor).toBeNull();
    expect(summary.returnPercent).toBeNull();
  });
});

describe("SSIS NAV stats and series", () => {
  const extracted = extractSsisSnapshot(buildSsisPayload());

  it("computes min/max/average purchase NAV and change from min", () => {
    const stats = computeSsisNavStats({ purchases: extracted.purchases, currentNavMinor: 1100 });
    expect(stats.minNavMinor).toBe(1000);
    expect(stats.maxNavMinor).toBe(1020);
    expect(stats.avgNavMinor).toBe(1013); // (1000+1020+1020)/3 = 1013.33 → 1013
    expect(stats.changeFromMinPercent).toBe(10);
  });

  it("builds cumulative invested vs current-value growth points", () => {
    const { purchaseSeries, valueGrowth } = buildSsisSeries({
      purchases: extracted.purchases,
      currentNavMinor: 1100
    });
    expect(purchaseSeries.map((p) => p.date)).toEqual(["2024-01-15", "2024-02-15", "2024-03-15"]);
    expect(valueGrowth.map((p) => p.investedMinor)).toEqual([100250, 151250, 177260]);
    expect(valueGrowth.map((p) => p.valueMinor)).toEqual([110275, 165275, 193325]);
  });
});

describe("BO account masking", () => {
  it("shows only the last four digits", () => {
    expect(maskBoAccountNo("1301999888777666")).toBe("••••7666");
    expect(maskBoAccountNo(null)).toBeNull();
  });
});
