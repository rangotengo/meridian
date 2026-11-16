import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client";
import { portfolioHoldings } from "../db/schema";
import type { Actor } from "../auth/context";
import { DomainError, errors } from "@/lib/errors";
import { parseAmountToMinor } from "@/lib/money";
import { recordAudit } from "../observability/audit";
import {
  loadManagedAccount,
  normalizeTicker,
  parseQuantity,
  syncPortfolioValuation
} from "./holdings";

/**
 * CSV import for manual portfolio holdings.
 *
 * Format: a header row is required. Columns:
 *   ticker,quantity,average_cost,current_price,company_name
 * `ticker` and `quantity` columns are required; the price and company
 * columns are optional. Prices are in MAJOR units (e.g. 250.50) and are
 * converted with the account's currency; empty price cells mean "unknown".
 * Quantities are decimal share counts (up to 6 decimal places).
 *
 * Rows are upserted by (account, ticker). A row that fails validation is
 * skipped and reported with its row number (the header is row 1); valid
 * rows still apply. A file with no usable header — empty, not CSV-shaped,
 * or missing the ticker/quantity columns — is rejected outright.
 */

export type HoldingsCsvRow = {
  row: number;
  ticker: string;
  companyName: string | null;
  quantity: string;
  averageCostMinor: number | null;
  currentPriceMinor: number | null;
};

export type HoldingsCsvRowError = { row: number; message: string };

export type HoldingsCsvParse = {
  rows: HoldingsCsvRow[];
  errors: HoldingsCsvRowError[];
};

export type HoldingsImportResult = {
  created: number;
  updated: number;
  errors: HoldingsCsvRowError[];
};

/** Split CSV text into records of fields (RFC 4180 subset: quotes, commas, CRLF). */
function splitCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;
  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    sawAny = true;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushRecord();
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (inQuotes) throw errors.validation("The CSV file has an unterminated quoted field.");
  if (sawAny && (field !== "" || record.length > 0)) pushRecord();
  return records;
}

function canonicalHeader(cell: string): string {
  return cell
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof DomainError ? e.userMessage : fallback;
}

/**
 * Parse and validate CSV text against an account currency. Pure — no
 * database access — so it is unit-testable in isolation. Structural
 * problems throw; per-row problems are collected.
 */
export function parseHoldingsCsv(csvText: string, currency: string): HoldingsCsvParse {
  if (!csvText || csvText.trim() === "") {
    throw errors.validation("Choose a CSV file with a header row and at least one holding.");
  }
  const records = splitCsvRecords(csvText);
  if (records.length === 0) throw errors.validation("The CSV file is empty.");
  const header = records[0]!.map(canonicalHeader);
  const column = (name: string) => header.indexOf(name);
  const tickerCol = column("ticker");
  const quantityCol = column("quantity");
  if (tickerCol === -1 || quantityCol === -1) {
    throw errors.validation(
      "The CSV header must include ticker and quantity columns (plus optional average_cost, current_price, company_name)."
    );
  }
  const avgCostCol = column("averagecost");
  const currentPriceCol = column("currentprice");
  const companyCol = column("companyname");

  const rows: HoldingsCsvRow[] = [];
  const rowErrors: HoldingsCsvRowError[] = [];

  for (let r = 1; r < records.length; r++) {
    const record = records[r]!;
    const rowNumber = r + 1;
    if (record.every((cell) => cell.trim() === "")) continue; // blank line
    const cell = (idx: number) => (idx === -1 ? "" : (record[idx] ?? "").trim());
    try {
      const ticker = normalizeTicker(cell(tickerCol));
      if (!ticker) throw errors.validation("Missing ticker.");
      if (ticker.length > 32 || /\s/.test(ticker)) {
        throw errors.validation(`"${cell(tickerCol)}" is not a valid ticker symbol.`);
      }
      const { scaled, normalized } = parseQuantity(cell(quantityCol));
      if (scaled === 0n) throw errors.validation("Quantity must be greater than zero.");
      const price = (idx: number, label: string): number | null => {
        const raw = cell(idx);
        if (raw === "") return null;
        try {
          return parseAmountToMinor(raw.replace(/,/g, ""), currency);
        } catch (e) {
          throw errors.validation(errorMessage(e, `Invalid ${label}.`));
        }
      };
      const averageCostMinor = price(avgCostCol, "average cost");
      if (averageCostMinor !== null && averageCostMinor < 0) {
        throw errors.validation("Average cost cannot be negative.");
      }
      const currentPriceMinor = price(currentPriceCol, "current price");
      if (currentPriceMinor !== null && currentPriceMinor < 0) {
        throw errors.validation("Current price cannot be negative.");
      }
      const company = cell(companyCol);
      rows.push({
        row: rowNumber,
        ticker,
        companyName: company ? company.slice(0, 200) : null,
        quantity: normalized,
        averageCostMinor,
        currentPriceMinor
      });
    } catch (e) {
      rowErrors.push({ row: rowNumber, message: errorMessage(e, "Invalid row.") });
    }
  }
  return { rows, errors: rowErrors };
}

export async function importHoldingsCsv(
  exec: Executor,
  actor: Actor,
  accountId: string,
  csvText: string
): Promise<HoldingsImportResult> {
  const account = await loadManagedAccount(exec, actor, accountId);
  const parsed = parseHoldingsCsv(csvText, account.currency);

  let created = 0;
  let updated = 0;
  await exec.transaction(async (tx) => {
    for (const row of parsed.rows) {
      const [existing] = await tx
        .select({ id: portfolioHoldings.id, companyName: portfolioHoldings.companyName })
        .from(portfolioHoldings)
        .where(
          and(eq(portfolioHoldings.accountId, account.id), eq(portfolioHoldings.ticker, row.ticker))
        )
        .limit(1);
      if (existing) {
        await tx
          .update(portfolioHoldings)
          .set({
            companyName: row.companyName ?? existing.companyName,
            quantity: row.quantity,
            averageCostMinor: row.averageCostMinor,
            currentPriceMinor: row.currentPriceMinor,
            updatedAt: new Date()
          })
          .where(eq(portfolioHoldings.id, existing.id));
        updated++;
      } else {
        await tx.insert(portfolioHoldings).values({
          accountId: account.id,
          ticker: row.ticker,
          companyName: row.companyName,
          quantity: row.quantity,
          averageCostMinor: row.averageCostMinor,
          currentPriceMinor: row.currentPriceMinor
        });
        created++;
      }
    }
    if (created + updated > 0) await syncPortfolioValuation(tx, actor, account);
  });

  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "holding.imported",
    entityType: "account",
    entityId: account.id,
    metadata: { accountId: account.id, created, updated, errors: parsed.errors.length }
  });

  return { created, updated, errors: parsed.errors };
}
