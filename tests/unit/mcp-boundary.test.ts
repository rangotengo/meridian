import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BREAKDOWN_MERCHANT_SCOPE,
  MCP_READ_SCOPES,
  NOTES_SCOPE,
  TOOL_SCOPES
} from "@/server/mcp/scopes";

// Structural guards for the MCP module: read-only must hold by
// construction (the module imports no mutation service), and every
// registered tool must be wired to the scope map its handler enforces.

const mcpDir = path.resolve(__dirname, "../../src/server/mcp");
const serverSource = readFileSync(path.join(mcpDir, "server.ts"), "utf8");
const cimdSource = readFileSync(path.join(mcpDir, "cimd.ts"), "utf8");

function importedNames(source: string): { name: string; from: string }[] {
  const out: { name: string; from: string }[] = [];
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g;
  for (const match of source.matchAll(re)) {
    const from = match[2]!;
    for (const part of match[1]!.split(",")) {
      const cleaned = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]!
        .trim();
      if (cleaned) out.push({ name: cleaned, from });
    }
  }
  return out;
}

/** Domain-layer mutation entry points the MCP module must never import. */
const MUTATION_SYMBOLS = [
  "addTransaction",
  "createTransactionEntry",
  "updateTransactionEntry",
  "deleteEntry",
  "restoreEntry",
  "setBudget",
  "removeBudget",
  "createSeries",
  "updateSeries",
  "deleteSeries",
  "setSeriesActive",
  "postDueSeries",
  "createAccount",
  "updateAccount",
  "deleteAccount",
  "upsertRate",
  "deleteRate",
  "createCategory",
  "updateCategory",
  "deleteCategory",
  // SSIS mutators: the MCP SSIS tools are read-only by construction.
  "importSsisSnapshot",
  "refreshSsis",
  "setSsisBoAccountNo"
];

/** The only domain services the MCP tools may call (plus type-only names). */
const READ_SERVICE_ALLOWLIST = new Set([
  // values
  "latestBalancesFor",
  "budgetOverview",
  "listEntriesPage",
  "convertMinor",
  "getRateInfo",
  "listSeries",
  "nextOccurrence",
  "netWorthSeries",
  "incomeExpenseSeries",
  "spendingByCategory",
  "spendingByMerchant",
  "currentMonthRange",
  "dashboardSummary",
  "accessibleAccountIds",
  "recordAudit",
  // SSIS read model (domain/ssis): calculations and row projections
  // only — the mutators above stay banned.
  "getSsisCoverage",
  "getSsisInsight",
  "resolveCurrentNav",
  "toSsisNavPoint",
  "toSsisPurchaseRow",
  "toSsisStatementRow",
  "SsisDatasetCoverage",
  // types
  "DashboardSummary",
  "FxCompleteness",
  "Frequency",
  "SeriesConfig",
  "McpAccess",
  "Executor"
]);

describe("MCP module boundary", () => {
  it("imports no mutation service in server.ts or cimd.ts", () => {
    for (const source of [serverSource, cimdSource]) {
      const names = importedNames(source).map((i) => i.name);
      for (const banned of MUTATION_SYMBOLS) {
        expect(names, `mutation symbol ${banned} must not be imported`).not.toContain(banned);
      }
      expect(source).not.toContain("domain/orchestrate");
    }
  });

  it("calls only allowlisted read services from the domain layer", () => {
    const domainImports = importedNames(serverSource).filter(
      (i) => i.from.includes("/domain/") || i.from.startsWith("../domain/")
    );
    expect(domainImports.length).toBeGreaterThan(0);
    for (const entry of domainImports) {
      expect(
        READ_SERVICE_ALLOWLIST.has(entry.name),
        `${entry.name} from ${entry.from} is not an approved read service`
      ).toBe(true);
    }
  });

  it("registers exactly the tools present in TOOL_SCOPES", () => {
    const registered = [...serverSource.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map(
      (m) => m[1]!
    );
    expect(registered.sort()).toEqual(Object.keys(TOOL_SCOPES).sort());
  });

  it("enforces each tool's scope inside its handler via the scope map", () => {
    for (const tool of Object.keys(TOOL_SCOPES)) {
      expect(
        serverSource.includes(`requireScope(TOOL_SCOPES.${tool})`),
        `${tool} handler must call requireScope(TOOL_SCOPES.${tool})`
      ).toBe(true);
    }
    expect(serverSource).toContain("requireScope(BREAKDOWN_MERCHANT_SCOPE)");
    expect(serverSource).toContain("NOTES_SCOPE");
  });

  it("maps every tool to a scope the authorization server can issue", () => {
    for (const scope of Object.values(TOOL_SCOPES)) {
      expect(MCP_READ_SCOPES).toContain(scope);
    }
    expect(MCP_READ_SCOPES).toContain(NOTES_SCOPE);
    expect(MCP_READ_SCOPES).toContain(BREAKDOWN_MERCHANT_SCOPE);
  });
});
