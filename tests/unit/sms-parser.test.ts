import { describe, it, expect } from "vitest";
import { parseSms, amountTextToMinor } from "@/server/domain/sms-parser";

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
