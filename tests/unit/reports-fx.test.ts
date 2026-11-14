import { describe, expect, it } from "vitest";
import type { Executor } from "@/server/db/client";
import { netWorthMinorForAccounts } from "@/server/domain/reports";
import { getRateInfo, isStaleRate, listLatestRates } from "@/server/domain/exchange-rates";

function stubExec(rate: string | null): Executor {
  return {
    execute: async () => ({ rows: rate === null ? [] : [{ rate }] }),
    insert: () => ({ values: async () => undefined })
  } as unknown as Executor;
}

const family = { id: "00000000-0000-0000-0000-000000000001", currency: "USD" };
const ON = "2026-08-27";

describe("netWorthMinorForAccounts", () => {
  it("sums directly when every account is already in the family currency", async () => {
    const total = await netWorthMinorForAccounts(
      stubExec(null),
      family,
      [
        { displayBalanceMinor: 1500, currency: "USD" },
        { displayBalanceMinor: -500, currency: "USD" }
      ],
      ON
    );
    expect(total).toBe(1000);
  });

  it("converts foreign-currency balances through the exchange rate", async () => {
    const total = await netWorthMinorForAccounts(
      stubExec("0.01"),
      family,
      [
        { displayBalanceMinor: 1500, currency: "USD" },
        { displayBalanceMinor: 9500, currency: "NPR" }
      ],
      ON
    );
    expect(total).toBe(1595);
  });

  it("excludes accounts with no known rate instead of raw-summing them", async () => {
    const total = await netWorthMinorForAccounts(
      stubExec(null),
      family,
      [
        { displayBalanceMinor: 1500, currency: "USD" },
        { displayBalanceMinor: 9500, currency: "NPR" }
      ],
      ON
    );
    expect(total).toBe(1500);
  });
});

describe("getRateInfo", () => {
  function stubRateExec(row: { rate: string; quoted_on: string } | null): Executor {
    return {
      execute: async () => ({ rows: row === null ? [] : [row] })
    } as unknown as Executor;
  }

  it("returns the rate together with its quoted-on date", async () => {
    const info = await getRateInfo(
      stubRateExec({ rate: "133.50000000", quoted_on: "2026-08-20" }),
      "USD",
      "NPR",
      ON
    );
    expect(info).toEqual({
      base: "USD",
      quote: "NPR",
      rate: "133.50000000",
      quotedOn: "2026-08-20"
    });
  });

  it("returns null when no rate exists on or before the date", async () => {
    expect(await getRateInfo(stubRateExec(null), "USD", "NPR", ON)).toBeNull();
  });

  it("short-circuits same-currency pairs without hitting the database", async () => {
    const info = await getRateInfo(stubRateExec(null), "npr", "NPR", ON);
    expect(info?.rate).toBe("1");
  });
});

describe("isStaleRate", () => {
  it("treats rates older than 30 days as stale, exactly 30 as fresh", () => {
    expect(isStaleRate("2026-07-28", "2026-08-27")).toBe(false);
    expect(isStaleRate("2026-07-27", "2026-08-27")).toBe(true);
    expect(isStaleRate("2026-08-27", "2026-08-27")).toBe(false);
  });

  it("never calls an unparseable date stale", () => {
    expect(isStaleRate("", "2026-08-27")).toBe(false);
    expect(isStaleRate("not-a-date", "2026-08-27")).toBe(false);
  });
});

describe("listLatestRates", () => {
  it("keeps only the newest row per ordered pair", async () => {
    const rows = [
      { base: "USD", quote: "NPR", rate: "134", quotedOn: "2026-08-25" },
      { base: "USD", quote: "NPR", rate: "133", quotedOn: "2026-08-20" },
      { base: "EUR", quote: "NPR", rate: "145", quotedOn: "2026-08-24" }
    ];
    const exec = {
      select: () => ({
        from: () => ({
          orderBy: async () => rows
        })
      })
    } as unknown as Executor;
    const latest = await listLatestRates(exec);
    expect(latest).toEqual([
      { base: "EUR", quote: "NPR", rate: "145", quotedOn: "2026-08-24" },
      { base: "USD", quote: "NPR", rate: "134", quotedOn: "2026-08-25" }
    ]);
  });
});
