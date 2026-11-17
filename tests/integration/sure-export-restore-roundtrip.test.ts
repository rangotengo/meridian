import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { db, makeUser, truncateAll, actorOf, latestBalance } from "../helpers";
import { importSureExport } from "@/server/domain/sure-import";
import { listAccountsForActor } from "@/server/domain/accounts";
import * as exportsSvc from "@/server/domain/exports";
import { importFamilyExport, parseFamilyExport } from "@/server/domain/family-import";

beforeAll(async () => {
  await truncateAll();
});

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

// Same expected balances as the Sure import comparison: a household
// export/restore round-trip must not change any account's balance. The
// Sure file itself is Arun's private export data and is NOT committed;
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

describe("Sure import -> household export/restore round-trip", () => {
  it("restores every account at its Sure balance, loans still valuation-tracked", async () => {
    const path = process.env.SURE_NDJSON_PATH;
    if (!path) {
      console.log("SURE_NDJSON_PATH not set — skipping real-data round-trip test");
      return;
    }
    const source = await makeUser({
      familyName: "Sure round-trip source",
      timezone: "Asia/Kathmandu"
    });
    const sourceActor = actorOf(source);
    const bytes = readFileSync(path);
    const imported = await importSureExport(db(), sourceActor, "sure-direct-import.ndjson", bytes);
    expect(imported.accounts).toBe(19);

    const exported = await exportsSvc.buildFamilyExport(db(), sourceActor);
    const target = await makeUser({
      familyName: "Sure round-trip target",
      timezone: "Asia/Kathmandu"
    });
    const targetActor = actorOf(target);
    const restored = await importFamilyExport(
      db(),
      targetActor,
      parseFamilyExport(encode(exported))
    );
    expect(restored.accounts).toBe(19);

    const accounts = await listAccountsForActor(db(), targetActor);
    expect(accounts).toHaveLength(19);
    const byName = new Map(accounts.map((a) => [a.name, a]));
    for (const [name, minor] of Object.entries(EXPECTED)) {
      const account = byName.get(name);
      expect(account, `missing account ${name}`).toBeDefined();
      expect(account!.displayBalanceMinor).toBe(minor);
      const latest = await latestBalance(account!.id);
      expect(latest?.balanceMinor).toBe(minor);
    }
    for (const name of LOAN_NAMES) {
      const account = byName.get(name)!;
      const mode = (account as { balanceTracking?: string | null }).balanceTracking;
      if (mode !== undefined) expect(mode).toBe("valuation");
    }
  });
});
