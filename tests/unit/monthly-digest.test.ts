import { describe, expect, it } from "vitest";
import { CRON_DEFINITIONS, createJobRegistry } from "@/server/queue/jobs";
import { isValidCron } from "@/server/queue/cron";
import { previousMonthRange } from "@/server/domain/reports";
import {
  composeDigestText,
  digestSubject,
  isDigestOptedIn,
  MONTHLY_DIGEST_QUEUE
} from "@/server/domain/monthly-digest";

describe("previousMonthRange", () => {
  it("returns the calendar month before now", () => {
    expect(previousMonthRange("Etc/UTC", new Date("2026-11-15T12:00:00Z"))).toEqual({
      monthKey: "2026-10",
      from: "2026-10-01",
      to: "2026-10-31"
    });
  });

  it("wraps across a year boundary", () => {
    expect(previousMonthRange("Etc/UTC", new Date("2026-01-10T12:00:00Z"))).toEqual({
      monthKey: "2025-12",
      from: "2025-12-01",
      to: "2025-12-31"
    });
  });

  it("computes the previous month in the family's timezone, not UTC", () => {
    // 2026-10-31T19:30Z is still October in UTC (previous: September) but
    // already November 1st in Kathmandu (previous: October).
    const at = new Date("2026-10-31T19:30:00Z");
    expect(previousMonthRange("Etc/UTC", at).monthKey).toBe("2026-09");
    expect(previousMonthRange("Asia/Kathmandu", at)).toEqual({
      monthKey: "2026-10",
      from: "2026-10-01",
      to: "2026-10-31"
    });
    // And a family behind UTC just after midnight UTC on the 1st is still
    // on the previous local month.
    const midnight = new Date("2026-11-01T00:30:00Z");
    expect(previousMonthRange("Etc/UTC", midnight).monthKey).toBe("2026-10");
    expect(previousMonthRange("America/New_York", midnight).monthKey).toBe("2026-09");
  });
});

describe("isDigestOptedIn", () => {
  it("is true only for an exact boolean true", () => {
    expect(isDigestOptedIn({ monthly_digest: true })).toBe(true);
    expect(isDigestOptedIn({})).toBe(false);
    expect(isDigestOptedIn({ monthly_digest: false })).toBe(false);
    expect(isDigestOptedIn({ monthly_digest: "true" })).toBe(false);
    expect(isDigestOptedIn({ monthly_digest: 1 })).toBe(false);
    expect(isDigestOptedIn(null)).toBe(false);
    expect(isDigestOptedIn(undefined)).toBe(false);
    expect(isDigestOptedIn('{"monthly_digest":true}')).toBe(true);
    expect(isDigestOptedIn('{"monthly_digest":"yes"}')).toBe(false);
    expect(isDigestOptedIn("not json")).toBe(false);
    expect(isDigestOptedIn([])).toBe(false);
  });
});

describe("digest composition", () => {
  const base = {
    familyName: "Karki family",
    currency: "USD",
    monthLabel: "October 2026",
    asOf: "2026-10-31",
    netWorthMinor: 270000,
    incomeMinor: 250000,
    expenseMinor: 80000,
    savingsMinor: 170000,
    incompleteFx: false,
    appUrl: "http://localhost:3000"
  };

  it("builds a totals-only subject and body with formatted figures and a dashboard link", () => {
    expect(digestSubject("October 2026")).toBe("Meridian — October 2026 summary");
    const text = composeDigestText(base);
    expect(text).toContain("October 2026");
    expect(text).toContain("Karki family");
    expect(text).toContain("$2,700.00");
    expect(text).toContain("$2,500.00");
    expect(text).toContain("$800.00");
    expect(text).toContain("$1,700.00");
    expect(text).toContain("View your dashboard: http://localhost:3000");
    expect(text).not.toContain("Some amounts were excluded");
  });

  it("adds the FX exclusion sentence only when conversion was incomplete", () => {
    expect(composeDigestText(base)).not.toContain("exchange rate was missing");
    expect(composeDigestText({ ...base, incompleteFx: true })).toContain(
      "Some amounts were excluded because an exchange rate was missing."
    );
  });
});

describe("monthly digest schedule", () => {
  it("registers a monthly cron definition off the top of the hour", () => {
    const def = CRON_DEFINITIONS.find((d) => d.key === "monthly-digest");
    expect(def).toMatchObject({ queue: MONTHLY_DIGEST_QUEUE, cron: "17 6 1 * *" });
    expect(isValidCron(def!.cron)).toBe(true);
  });

  it("registers the digest:monthly handler alongside the existing queues", async () => {
    const registry = await createJobRegistry();
    expect(registry.get("digest:monthly")).toBeDefined();
    expect(registry.get("email")).toBeDefined();
    expect(registry.get("recurring:post")).toBeDefined();
  });
});
