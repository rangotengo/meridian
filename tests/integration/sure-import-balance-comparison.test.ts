import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { db, makeUser, truncateAll, actorOf, latestBalance } from "../helpers";
import { importSureExport } from "@/server/domain/sure-import";
import { listAccountsForActor } from "@/server/domain/accounts";

beforeAll(async () => {
  await truncateAll();
});

// Expected display balances (minor units) after importing the preserved
// Sure direct-import file: valuation-tracked accounts take their latest
// valuation by date; depositories take Sure's `balance` field. This pins
// the 2026-11-15 production import outcome, so a later balance-engine
// change that zeroes a previously nonzero loan account fails here first.
//
// The file itself is Arun's private export data and is NOT committed:
// the test reads it from SURE_NDJSON_PATH and skips when it is unset.
const EXPECTED: Record<string, number> = {
  Esewa: 3000,
  "Dawa dai": 3000000,
  Ayush: 36415000,
  "Nabil Bank": 1500,
  "First Land": 90000000,
  "Ishower da": 19755000,
  Baniya: 1300000,
  "Siddhartha Bank": 1005300,
  "Rijan dai": 0,
  "Emergency Fund (Esmi di acc)": 27000000,
  "Mandip Vena": 70000000,
  "Rajesh Da": 1500000,
  "Vishal sir (USD Cash)": 1500000,
  "Maniac dai": 7000000,
  Nehal: 10580000,
  Roshan: 500000,
  Kanchu: 114200000,
  "ARUN SHRESTHA": 46891236,
  "PARKASH SAPKOTA": 107945979
};

const LOAN_NAMES = [
  "Dawa dai",
  "Ayush",
  "First Land",
  "Ishower da",
  "Baniya",
  "Mandip Vena",
  "Rajesh Da",
  "Vishal sir (USD Cash)",
  "Maniac dai",
  "Nehal",
  "Roshan",
  "Kanchu",
  "ARUN SHRESTHA",
  "PARKASH SAPKOTA"
];

describe("Sure import balance comparison (same data, old vs new code)", () => {
  it("imports the preserved Sure file and shows the Sure balances", async () => {
    const path = process.env.SURE_NDJSON_PATH;
    if (!path) {
      console.log("SURE_NDJSON_PATH not set — skipping real-data comparison test");
      return;
    }
    const user = await makeUser({
      familyName: "Sure comparison family",
      timezone: "Asia/Kathmandu"
    });
    const actor = actorOf(user);
    const bytes = readFileSync(path);
    const result = await importSureExport(db(), actor, "sure-direct-import.ndjson", bytes);
    expect(result.accounts).toBe(19);
    expect(result.valuations).toBe(28);
    const accounts = await listAccountsForActor(db(), actor);
    expect(accounts).toHaveLength(19);
    const byName = new Map(accounts.map((a) => [a.name, a]));
    for (const [name, minor] of Object.entries(EXPECTED)) {
      const account = byName.get(name);
      expect(account, `missing account ${name}`).toBeDefined();
      expect(account!.displayBalanceMinor).toBe(minor);
      const latest = await latestBalance(account!.id);
      expect(latest?.balanceMinor).toBe(minor);
    }
    // Loans must still be valuation-tracked on code that has the column.
    for (const name of LOAN_NAMES) {
      const account = byName.get(name)!;
      const mode = (account as { balanceTracking?: string | null }).balanceTracking;
      if (mode !== undefined) expect(mode).toBe("valuation");
    }
  });
});
