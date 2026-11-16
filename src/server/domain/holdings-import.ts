import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client";
import { portfolioHoldings } from "../db/schema";
import type { Actor } from "../auth/context";
import { DomainError, errors } from "@/lib/errors";
import { parseAmountToMinor } from "@/lib/money";
import { recordAudit } from "../observability/audit";
import {
  assertHoldingsActivationAllowed,
  formatQuantity,
  isPositionPriceable,
  knownCostScaled,
  loadManagedAccount,
  normalizeTicker,
  parseQuantity,
  syncPortfolioValuation,
  withHoldingsAccountLock,
  type PortfolioHoldingRow
} from "./holdings";

/**
 * CSV import for manual portfolio holdings.
 *
 * Format: a header row is required. Columns:
 *   ticker,quantity,average_cost,current_price,company_name
 * `ticker` and `quantity` columns are required; the price and company
 * columns are optional. Prices are in MAJOR units (e.g. 250.50) and are
 * converted with the account's currency. Quantities are decimal share
 * counts (up to 6 decimal places).
 *
 * Price columns are presence-aware on update: an OMITTED column leaves
 * the stored price untouched, while a present-but-blank cell explicitly
 * clears that price to unknown. A row whose result would leave the
 * holding without a usable price is an error — no current price and no
 * full-coverage average cost (see isPositionPriceable in holdings.ts);
 * e.g. clearing the current price of a position whose average cost
 * covers only some shares. The stored holding, if any, is left
 * unchanged. A supplied average cost describes the row's whole quantity;
 * a sparse row that omits the cost column keeps the stored cost
 * provenance, clamped to the new quantity.
 *
 * Rows are upserted by (account, ticker). A row that fails validation is
 * skipped and reported with its row number (the header is row 1); valid
 * rows still apply. A file with no usable header — empty, not CSV-shaped,
 * or missing the ticker/quantity columns — is rejected outright. The
 * whole import runs under the account's holdings lock (see holdings.ts).
 */

export type HoldingsCsvRow = {
  row: number;
  ticker: string;
  companyName: string | null;
  quantity: string;
  averageCostMinor: number | null;
  /** True when the file dictates the average cost (column present). */
  averageCostSet: boolean;
  currentPriceMinor: number | null;
  /** True when the file dictates the current price (column present). */
  currentPriceSet: boolean;
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
      // Presence-aware prices: an absent column does not dictate the
      // field; a present column dictates it, with a blank cell meaning an
      // explicit clear to unknown.
      const price = (idx: number, label: string): { set: boolean; value: number | null } => {
        if (idx === -1) return { set: false, value: null };
        const raw = cell(idx);
        if (raw === "") return { set: true, value: null };
        try {
          return { set: true, value: parseAmountToMinor(raw.replace(/,/g, ""), currency) };
        } catch (e) {
          throw errors.validation(errorMessage(e, `Invalid ${label}.`));
        }
      };
      const averageCost = price(avgCostCol, "average cost");
      if (averageCost.value !== null && averageCost.value < 0) {
        throw errors.validation("Average cost cannot be negative.");
      }
      const currentPrice = price(currentPriceCol, "current price");
      if (currentPrice.value !== null && currentPrice.value < 0) {
        throw errors.validation("Current price cannot be negative.");
      }
      const company = cell(companyCol);
      rows.push({
        row: rowNumber,
        ticker,
        companyName: company ? company.slice(0, 200) : null,
        quantity: normalized,
        averageCostMinor: averageCost.value,
        averageCostSet: averageCost.set,
        currentPriceMinor: currentPrice.value,
        currentPriceSet: currentPrice.set
      });
    } catch (e) {
      rowErrors.push({ row: rowNumber, message: errorMessage(e, "Invalid row.") });
    }
  }
  return { rows, errors: rowErrors };
}

const NO_PRICE_MESSAGE =
  "This row would leave the holding without a usable price — it needs a current price, or an average cost that covers all its shares. The stored holding was left unchanged.";

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
  const applyErrors: HoldingsCsvRowError[] = [];
  await withHoldingsAccountLock(exec, account.id, async (tx) => {
    // Re-resolve the managed-account guards inside the lock: the check
    // above ran before this import queued on it, and a balance-tracking
    // switch holding the same lock may have committed in between.
    const managed = await loadManagedAccount(tx, actor, account.id);
    if (parsed.rows.length > 0) {
      await assertHoldingsActivationAllowed(tx, actor, account.id);
    }
    for (const row of parsed.rows) {
      const [existing] = await tx
        .select()
        .from(portfolioHoldings)
        .where(
          and(eq(portfolioHoldings.accountId, account.id), eq(portfolioHoldings.ticker, row.ticker))
        )
        .limit(1);
      if (existing) {
        const merged = mergeRowIntoExisting(existing, row);
        if (!merged) {
          applyErrors.push({ row: row.row, message: NO_PRICE_MESSAGE });
          continue;
        }
        await tx
          .update(portfolioHoldings)
          .set({ ...merged, updatedAt: new Date() })
          .where(eq(portfolioHoldings.id, existing.id));
        updated++;
      } else {
        const averageCostMinor = row.averageCostSet ? row.averageCostMinor : null;
        const currentPriceMinor = row.currentPriceSet ? row.currentPriceMinor : null;
        const averageCostQuantity = averageCostMinor !== null ? row.quantity : "0";
        if (
          !isPositionPriceable({
            ticker: row.ticker,
            quantity: row.quantity,
            averageCostMinor,
            averageCostQuantity,
            currentPriceMinor
          })
        ) {
          applyErrors.push({ row: row.row, message: NO_PRICE_MESSAGE });
          continue;
        }
        await tx.insert(portfolioHoldings).values({
          accountId: account.id,
          ticker: row.ticker,
          companyName: row.companyName,
          quantity: row.quantity,
          averageCostMinor,
          averageCostQuantity,
          currentPriceMinor
        });
        created++;
      }
    }
    if (created + updated > 0) await syncPortfolioValuation(tx, actor, managed);
  });

  const errors = [...parsed.errors, ...applyErrors].sort((a, b) => a.row - b.row);
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "holding.imported",
    entityType: "account",
    entityId: account.id,
    metadata: { accountId: account.id, created, updated, errors: errors.length }
  });

  return { created, updated, errors };
}

/**
 * Merges a CSV row into a stored holding under the presence rules: a
 * dictated field (column present) replaces the stored value, including an
 * explicit clear; an omitted field preserves it. Returns null when the
 * merged holding would not be priceable (no current price and no
 * full-coverage average cost) — the caller reports a row error and the
 * stored holding is left unchanged.
 */
function mergeRowIntoExisting(
  existing: PortfolioHoldingRow,
  row: HoldingsCsvRow
): {
  companyName: string | null;
  quantity: string;
  averageCostMinor: number | null;
  averageCostQuantity: string;
  currentPriceMinor: number | null;
} | null {
  const averageCostMinor = row.averageCostSet ? row.averageCostMinor : existing.averageCostMinor;
  const currentPriceMinor = row.currentPriceSet
    ? row.currentPriceMinor
    : existing.currentPriceMinor;

  let averageCostQuantity: string;
  if (row.averageCostSet) {
    // A dictated cost describes the row's whole quantity; a dictated
    // clear makes the whole position's cost unknown.
    averageCostQuantity = averageCostMinor !== null ? row.quantity : "0";
  } else if (averageCostMinor === null) {
    averageCostQuantity = "0";
  } else {
    // Sparse row: keep the stored cost provenance, clamped to the new
    // quantity (the known portion can never exceed the position).
    const known = knownCostScaled(existing);
    const { scaled } = parseQuantity(row.quantity);
    averageCostQuantity = formatQuantity(known > scaled ? scaled : known);
  }
  const merged = {
    companyName: row.companyName ?? existing.companyName,
    quantity: row.quantity,
    averageCostMinor,
    averageCostQuantity,
    currentPriceMinor
  };
  if (!isPositionPriceable({ ticker: existing.ticker, ...merged })) return null;
  return merged;
}
