import { describe, it, expect, vi } from "vitest";
import { parseSms, amountTextToMinor, smsFallbackIdTail } from "@/server/domain/sms-parser";

describe("sms-parser", () => {
  it("parses Laxmi Sunrise credit SMS correctly", () => {
    const text = `Dear Customer, Your #88011052 has been credited by NPR 770.00 on 10/09/26. Remarks:FPQR-479651654-5834-24:FPQR-479651654-5834-24
-Laxmi Sunrise`;
    const sender = "LAXMI";

    const parsed = parseSms(text, sender);
    expect(parsed.kind).toBe("income");
    expect(parsed.amountMajor).toBe(770);
    expect(parsed.amountMinor).toBe(77000);
    expect(parsed.currency).toBe("NPR");
    expect(parsed.date).toBe("2026-09-10");
    expect(parsed.bankName).toBe("Laxmi Sunrise");
    expect(parsed.accountNumber).toBe("88011052");
    expect(parsed.accountDigits).toBe("88011052");
    expect(parsed.referenceId).toBeTruthy();
  });

  it("parses Nabil Bank debit SMS correctly", () => {
    const text = `Dear Customer, Your 110##02167 has been withdrawn by NPR 24,360.00 on 09/09/2026 14:13:30, Remarks: PREPAID CARD 150 T
Download App: https://rebrand.ly/nBank`;
    const sender = "Nabil_Alert";

    const parsed = parseSms(text, sender);
    expect(parsed.kind).toBe("expense");
    expect(parsed.amountMajor).toBe(24360);
    expect(parsed.amountMinor).toBe(2436000);
    expect(parsed.currency).toBe("NPR");
    expect(parsed.date).toBe("2026-09-09");
    expect(parsed.bankName).toBe("Nabil Bank");
    expect(parsed.accountNumber).toBe("110##02167");
    expect(parsed.accountDigits).toBe("02167");
    expect(parsed.remarks).toContain("PREPAID CARD 150 T");
  });

  it("parses Siddhartha Bank deposit SMS correctly", () => {
    const text = `Dear ARUN, AC 0###15###9850, NPR 5,000.00 deposited on 09/09/2026 14:11:48 for Fund Trf frm NABIL BANK LTD -178894247201261c
Siddhartha Bank`;
    const sender = "SBL_ALERT";

    const parsed = parseSms(text, sender);
    expect(parsed.kind).toBe("income");
    expect(parsed.amountMajor).toBe(5000);
    expect(parsed.amountMinor).toBe(500000);
    expect(parsed.currency).toBe("NPR");
    expect(parsed.date).toBe("2026-09-09");
    expect(parsed.bankName).toBe("Siddhartha Bank");
    expect(parsed.accountDigits).toBe("9850");
    expect(parsed.remarks).toContain("Fund Trf frm NABIL BANK LTD");
    expect(parsed.referenceId).toContain("178894247201261c");
  });

  it("marks whether the date came from the SMS itself", () => {
    const withDate = parseSms("Dear Customer, NPR 500.00 debited on 09/09/2026", "SBL");
    expect(withDate.dateExplicit).toBe(true);
    expect(withDate.date).toBe("2026-09-09");

    const withoutDate = parseSms("Dear Customer, NPR 500.00 debited", "SBL");
    expect(withoutDate.dateExplicit).toBe(false);
    expect(withoutDate.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("sms-parser currency exponents", () => {
  it("derives minor units with the currency's real exponent (JPY = 0)", () => {
    const parsed = parseSms("Your account has been debited by JPY 1000 for train ticket", "NBL");
    expect(parsed.currency).toBe("JPY");
    expect(parsed.amountMinor).toBe(1000);
    expect(parsed.amountMajor).toBe(1000);
  });

  it("keeps cents for two-decimal currencies", () => {
    const parsed = parseSms("Your account has been credited by USD 10.50", "NBL");
    expect(parsed.currency).toBe("USD");
    expect(parsed.amountMinor).toBe(1050);
  });

  it("rounds sub-minor precision half away from zero", () => {
    expect(amountTextToMinor("100.999", "NPR")).toBe(10100);
    expect(amountTextToMinor("100.994", "NPR")).toBe(10099);
    expect(amountTextToMinor("2.5", "JPY")).toBe(3);
    expect(amountTextToMinor("2.4", "JPY")).toBe(2);
  });

  it("handles thousands separators", () => {
    expect(amountTextToMinor("24,360.00", "NPR")).toBe(2436000);
  });
});

describe("sms-parser — wallets", () => {
  it("parses an eSewa debit SMS", () => {
    const text = `Your eSewa account 9850 has been debited by NPR 500.00 on 17/11/2026. Remarks: Payment to Bhatbhateni`;
    const parsed = parseSms(text, "eSewa");
    expect(parsed.kind).toBe("expense");
    expect(parsed.amountMajor).toBe(500);
    expect(parsed.amountMinor).toBe(50000);
    expect(parsed.currency).toBe("NPR");
    expect(parsed.date).toBe("2026-11-17");
    expect(parsed.bankName).toBe("eSewa");
    expect(parsed.accountDigits).toBe("9850");
    expect(parsed.referenceId).toBeTruthy();
  });

  it("parses a Khalti credit SMS", () => {
    const text = `Your Khalti account has been credited by NPR 1,250.00 on 17/11/2026. Remarks: Received from 98XXXXXXXX`;
    const parsed = parseSms(text, "Khalti");
    expect(parsed.kind).toBe("income");
    expect(parsed.amountMajor).toBe(1250);
    expect(parsed.amountMinor).toBe(125000);
    expect(parsed.currency).toBe("NPR");
    expect(parsed.date).toBe("2026-11-17");
    expect(parsed.bankName).toBe("Khalti");
    expect(parsed.referenceId).toBeTruthy();
  });
});

describe("sms-parser — stable fallback identity", () => {
  const UNDATED = "Your account XX1234 debited NPR 100.00 at Store";

  it("gives the same undated SMS the same reference id on consecutive days", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
      const day1 = parseSms(UNDATED).referenceId;
      vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
      const day2 = parseSms(UNDATED).referenceId;
      // The defaulted "today" must not leak into the identity.
      expect(day1).toBe("sms_10000_1234_230b09eb42cd");
      expect(day2).toBe(day1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an explicit SMS date in the identity, stably across days", () => {
    const dated = "Your account XX1234 debited NPR 100.00 at Store on 15/11/2026";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
      const day1 = parseSms(dated).referenceId;
      vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
      const day2 = parseSms(dated).referenceId;
      // The hash covers the full text, so it differs from the undated
      // SMS; the point is the explicit date is in the id and it is stable.
      expect(day1).toMatch(/^sms_2026-11-15_10000_1234_[0-9a-f]{12}$/);
      expect(day2).toBe(day1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes the shared hash tail of new and legacy fallback ids", () => {
    expect(smsFallbackIdTail("sms_10000_1234_230b09eb42cd")).toBe("230b09eb42cd");
    expect(smsFallbackIdTail("sms_2026-11-17_10000_1234_230b09eb42cd")).toBe("230b09eb42cd");
    expect(smsFallbackIdTail("178894247201261c")).toBeNull();
    expect(smsFallbackIdTail(null)).toBeNull();
  });
});
