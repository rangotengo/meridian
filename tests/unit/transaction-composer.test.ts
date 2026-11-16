import { describe, expect, it } from "vitest";
import {
  compatibleDestinations,
  isComposerMode,
  parseComposerParams,
  type ComposerAccountOption
} from "@/lib/transaction-composer";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("parseComposerParams", () => {
  const eligible = new Set([A, B]);

  it("accepts a valid account and kind", () => {
    expect(parseComposerParams({ account: A, kind: "transfer" }, eligible)).toEqual({
      initialAccountId: A,
      initialMode: "transfer"
    });
    expect(parseComposerParams({ account: B, kind: "income" }, eligible)).toEqual({
      initialAccountId: B,
      initialMode: "income"
    });
  });

  it("defaults to expense with no preset when params are absent", () => {
    expect(parseComposerParams({}, eligible)).toEqual({
      initialAccountId: "",
      initialMode: "expense"
    });
    expect(parseComposerParams({ account: null, kind: null }, eligible)).toEqual({
      initialAccountId: "",
      initialMode: "expense"
    });
  });

  it("falls back to expense for an unrecognized kind instead of crashing", () => {
    expect(parseComposerParams({ kind: "bogus" }, eligible).initialMode).toBe("expense");
    expect(parseComposerParams({ kind: "TRANSFER" }, eligible).initialMode).toBe("expense");
    expect(parseComposerParams({ kind: "" }, eligible).initialMode).toBe("expense");
  });

  it("ignores a preset account that is not a UUID", () => {
    expect(parseComposerParams({ account: "not-an-account" }, eligible).initialAccountId).toBe("");
    expect(parseComposerParams({ account: "../../etc" }, eligible).initialAccountId).toBe("");
  });

  it("ignores a well-formed account the actor cannot create on", () => {
    // C is a valid UUID but not in the eligible (active, full-control) set.
    expect(parseComposerParams({ account: C, kind: "transfer" }, eligible)).toEqual({
      initialAccountId: "",
      initialMode: "transfer"
    });
  });

  it("isComposerMode recognizes exactly the three modes", () => {
    expect(isComposerMode("expense")).toBe(true);
    expect(isComposerMode("income")).toBe(true);
    expect(isComposerMode("transfer")).toBe(true);
    expect(isComposerMode("refund")).toBe(false);
    expect(isComposerMode(null)).toBe(false);
    expect(isComposerMode(undefined)).toBe(false);
  });
});

describe("compatibleDestinations", () => {
  const accounts: ComposerAccountOption[] = [
    { id: A, name: "Checking", currency: "USD" },
    { id: B, name: "Savings", currency: "USD" },
    { id: C, name: "Euro wallet", currency: "EUR" }
  ];

  it("offers other accounts in the source's currency", () => {
    expect(compatibleDestinations(accounts, A).map((a) => a.id)).toEqual([B]);
    expect(compatibleDestinations(accounts, B).map((a) => a.id)).toEqual([A]);
  });

  it("is empty when the source is the only account in its currency", () => {
    expect(compatibleDestinations(accounts, C)).toEqual([]);
  });

  it("recomputes from the current source, never the original preset", () => {
    // Switching the source from A to C must shrink the option set to none;
    // a stale destination from the A computation (B) must not survive.
    const forC = compatibleDestinations(accounts, C);
    expect(forC.some((a) => a.id === B)).toBe(false);
  });

  it("returns an empty list for an unknown source", () => {
    expect(compatibleDestinations(accounts, "99999999-9999-4999-8999-999999999999")).toEqual([]);
  });
});
