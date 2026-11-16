import { asc, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { usesCloudStorage } from "../db/dialect";
import {
  families,
  ssisInsightState,
  ssisNavHistory,
  ssisPurchases,
  ssisStatementEntries
} from "../db/schema";
import type { Actor } from "../auth/context";
import { recordAudit } from "../observability/audit";
import { errors, isDomainError } from "@/lib/errors";
import { isIsoDate, todayIn } from "@/lib/datetime";
import { fetchSsisSnapshot } from "./ssis-fetch";

/**
 * SSIS insight domain: a self-contained snapshot of the owner's Siddhartha
 * Systematic Investment Scheme (Siddhartha Capital, scheme_code "001").
 *
 * The upstream payload carries heavy PII (citizenship, PAN, DOB, bank and BO
 * account numbers, phone, email, an OTP field). Extraction here is a strict
 * WHITELIST: only the fields the insight views need are read out of the raw
 * payload, everything else is discarded and never persisted. The raw payload
 * itself is never stored, logged, or audited.
 *
 * This data never touches Meridian accounts/entries/balances — it has its
 * own tables and lifecycle (import / refresh), mirroring the standalone
 * SSIS dashboard's math.
 *
 * Single-holder policy: the insight holds ONE holder's datasets, bound to
 * the configured BO account number. Changing the BO number while holder
 * data exists requires an explicit confirmed switch, which clears the
 * previous holder's purchases and statement (scheme-level NAV history is
 * kept); an unconfirmed switch is rejected so two holders' rows can never
 * merge under one configuration. Every BO change bumps the state's
 * config_generation, and a refresh re-checks the generation it fetched for
 * inside its commit transaction — a refresh started for the old holder
 * therefore cannot write after a switch. Snapshot imports are bound by
 * holder identity, derived from every holder-bearing dataset (purchase
 * FName/LName and statement Name alike): a snapshot naming a different
 * holder than the stored data is rejected instead of merged, and a file
 * import carrying no identity at all is rejected once the insight holds
 * holder data — missing identity is not permission to merge. The mirror
 * case is rejected too: data imported without any identity stays
 * unidentified, and a later named file import cannot silently bind those
 * rows to a holder; the admin must clear them through a confirmed BO
 * switch first. Only a live refresh — bound to the configured BO account
 * by the generation check — may bind a name over unidentified data.
 */

export const SSIS_SCHEME_NAME = "Siddhartha Systematic Investment Scheme";
export const SSIS_SCHEME_CODE = "001";

const UNITS_SCALE = 4; // units are decimal strings with up to 4dp
const UNITS_FACTOR = 10_000n;

/**
 * Read-model values are JS numbers, so every quantity that can reach a
 * Number conversion must stay within the exactly-representable range.
 * Canonical unit quantities are bounded to a safe scaled integer at parse
 * time, and snapshot aggregates are checked before anything is persisted.
 */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The repo's family-level write gate: family admins hold full control of
 * household-level data (the same gate family-import uses for restores).
 * Viewing the insight only requires family membership.
 */
export function assertSsisAdmin(actor: Actor): void {
  if (actor.familyRole !== "admin") {
    throw errors.forbidden("Only a family admin can manage the SSIS insight.");
  }
}

// ---------------------------------------------------------------------------
// Defensive scalar parsing. Upstream values arrive as strings or numbers and
// are frequently blank, "-" (the statement's "no debit" marker), or null.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown, maxLength: number): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed.slice(0, maxLength);
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function decimalStringOf(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/,/g, "");
    return trimmed === "" ? null : trimmed;
  }
  return null;
}

/**
 * Parse a decimal (string or number) into a scaled BigInt with the given
 * number of fractional digits, rounding half-up when the source carries
 * more precision. Returns null for anything that is not a plain decimal.
 */
export function parseDecimalScaled(value: unknown, scaleDigits: number): bigint | null {
  const raw = decimalStringOf(value);
  if (raw === null) return null;
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) return null;
  const sign = match[1] ?? "";
  const intPart = match[2] ?? "";
  const frac = match[3] ?? "";
  if (intPart === "" && frac === "") return null;
  const factor = 10n ** BigInt(scaleDigits);
  let scaled = BigInt(intPart === "" ? "0" : intPart) * factor;
  if (frac.length <= scaleDigits) {
    scaled += BigInt(frac.padEnd(scaleDigits, "0") || "0");
  } else {
    const kept = frac.slice(0, scaleDigits);
    const dropped = frac.slice(scaleDigits);
    scaled += BigInt(kept || "0");
    if (dropped[0]! >= "5") scaled += 1n;
  }
  return sign === "-" ? -scaled : scaled;
}

/** Money/NAV values are 2dp in the source: parse to minor units (×100). */
export function parseMinor(value: unknown): bigint | null {
  return parseDecimalScaled(value, 2);
}

function toSafeNumber(value: bigint): number | null {
  if (value > MAX_SAFE || value < -MAX_SAFE) {
    return null;
  }
  return Number(value);
}

function minorOrNull(value: unknown): number | null {
  const parsed = parseMinor(value);
  if (parsed === null || parsed < 0n) return null;
  return toSafeNumber(parsed);
}

/** Statement amounts treat "", "-" and null as zero; real garbage is null. */
function minorOrZero(value: unknown): number | null {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string" && (value.trim() === "" || value.trim() === "-")) return 0;
  return minorOrNull(value);
}

export type ParsedUnits = { scaled: bigint; text: string };

/** Canonical decimal text for a scaled (4dp) unit quantity. */
export function unitsText(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const intPart = abs / UNITS_FACTOR;
  const fracPart = (abs % UNITS_FACTOR).toString().padStart(UNITS_SCALE, "0").replace(/0+$/, "");
  const text = fracPart === "" ? intPart.toString() : `${intPart}.${fracPart}`;
  return negative ? `-${text}` : text;
}

export function parseUnits(value: unknown): ParsedUnits | null {
  const scaled = parseDecimalScaled(value, UNITS_SCALE);
  if (scaled === null) return null;
  // Arbitrarily large quantities are not data the read model can value
  // exactly (units × NAV must stay a safe integer), so they are rejected
  // here and the row is skipped like any other malformed row.
  if (scaled > MAX_SAFE || scaled < -MAX_SAFE) return null;
  return { scaled, text: unitsText(scaled) };
}

function parseDateValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().slice(0, 10);
  return isIsoDate(candidate) ? candidate : null;
}

function truthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string")
    return ["1", "true", "y", "yes"].includes(value.trim().toLowerCase());
  return false;
}

// ---------------------------------------------------------------------------
// Whitelist extraction. Only the fields named here are ever read from the
// raw payload; every other field (PII included) is dropped on the floor.
// ---------------------------------------------------------------------------

export type SsisPurchaseRow = {
  requestNo: string;
  applyDate: string;
  units: string;
  amountMinor: number;
  status: string;
  purchaseNavMinor: number | null;
  navDate: string | null;
  schemeName: string | null;
  isSip: boolean;
};

export type SsisStatementRow = {
  transNo: string;
  installmentDate: string;
  dueDate: string | null;
  actionDate: string | null;
  amountCrMinor: number;
  amountDrMinor: number;
  units: string | null;
  appliedNavMinor: number | null;
  payment: string | null;
  otherChargesMinor: number;
  sebonFeeMinor: number;
  sipRegNo: string | null;
};

export type SsisNavPoint = { engDate: string; nepDate: string; navMinor: number };

export type SsisExtractedSnapshot = {
  purchases: SsisPurchaseRow[];
  statement: SsisStatementRow[];
  navHistory: SsisNavPoint[];
  holderName: string | null;
  /** Every distinct holder name asserted by any dataset (0 or 1 entries). */
  holderNames: string[];
  navDataNav: { navMinor: number; navDate: string } | null;
  skipped: number;
};

function extractPurchase(row: unknown): SsisPurchaseRow | null {
  if (!isRecord(row)) return null;
  const requestNo = textValue(row.REQUEST_NO, 64);
  const applyDate = parseDateValue(row.APPLY_DT);
  const units = parseUnits(row.APPLY_UNIT);
  const amountMinor = minorOrNull(row.AMOUNT);
  if (!requestNo || !applyDate || !units || units.scaled <= 0n || amountMinor === null) {
    return null;
  }
  return {
    requestNo,
    applyDate,
    units: units.text,
    amountMinor,
    status: textValue(row.APPSTATUS, 64) ?? "",
    purchaseNavMinor: minorOrNull(row.current_nav),
    navDate: parseDateValue(row.nav_date),
    schemeName: textValue(row.SchemeName, 200),
    isSip: truthyFlag(row.Is_SIP)
  };
}

function extractStatementRow(row: unknown): SsisStatementRow | null {
  if (!isRecord(row)) return null;
  const transNo = textValue(row.trans_no, 64);
  const installmentDate = parseDateValue(row.installmentDate);
  const actionDate = parseDateValue(row.actionDate);
  if (!transNo || (!installmentDate && !actionDate)) return null;
  const amountCrMinor = minorOrZero(row.Amount_cr);
  const amountDrMinor = minorOrZero(row.Amount_dr);
  const otherChargesMinor = minorOrZero(row.otherCharges);
  const sebonFeeMinor = minorOrZero(row.sebon_fee);
  if (
    amountCrMinor === null ||
    amountDrMinor === null ||
    otherChargesMinor === null ||
    sebonFeeMinor === null
  ) {
    return null;
  }
  const rawUnits = decimalStringOf(row.unit);
  const units = rawUnits === null ? null : parseUnits(row.unit);
  if (rawUnits !== null && !units) return null;
  const rawNav = decimalStringOf(row.appnav);
  const appliedNavMinor = rawNav === null ? null : minorOrNull(row.appnav);
  if (rawNav !== null && appliedNavMinor === null) return null;
  return {
    transNo,
    installmentDate: (installmentDate ?? actionDate)!,
    dueDate: parseDateValue(row.dueDate),
    actionDate,
    amountCrMinor,
    amountDrMinor,
    units: units ? units.text : null,
    appliedNavMinor,
    payment: textValue(row.payment, 120),
    otherChargesMinor,
    sebonFeeMinor,
    sipRegNo: textValue(row.SIP_Reg_No, 64)
  };
}

function extractNavPoint(row: unknown): SsisNavPoint | null {
  if (!isRecord(row)) return null;
  const engDate = parseDateValue(row.eng_date);
  const navMinor = minorOrNull(row.nav);
  if (!engDate || navMinor === null || navMinor <= 0) return null;
  return { engDate, nepDate: parseDateValue(row.nep_date) ?? engDate, navMinor };
}

function extractNavDataNav(navData: unknown): { navMinor: number; navDate: string } | null {
  if (!isRecord(navData)) return null;
  const responseData = navData.ResponseData;
  const first = Array.isArray(responseData) ? responseData[0] : responseData;
  if (!isRecord(first)) return null;
  const navMinor = minorOrNull(first.nav_value);
  const navDate = parseDateValue(first.nav_date);
  if (navMinor === null || !navDate) return null;
  return { navMinor, navDate };
}

/**
 * Holder identity can appear in either holder-bearing dataset: purchase
 * rows carry FName/LName, statement rows carry a single Name. Identity is
 * derived from ALL of them — a name that only appears in the statement
 * must still bind (and still be checked), or a statement-only snapshot
 * could merge another holder's rows under the stored holder.
 */
function rowHolderName(row: unknown): string | null {
  if (!isRecord(row)) return null;
  const full = textValue(row.Name, 240);
  if (full) return full;
  const first = textValue(row.FName, 120);
  const last = textValue(row.LName, 120);
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name === "" ? null : name;
}

/** Distinct holder names across rows, compared case/whitespace-insensitively. */
function distinctHolderNames(rows: unknown[]): string[] {
  const byNormalized = new Map<string, string>();
  for (const row of rows) {
    const name = rowHolderName(row);
    if (name && !byNormalized.has(normalizeHolderName(name))) {
      byNormalized.set(normalizeHolderName(name), name);
    }
  }
  return [...byNormalized.values()];
}

/**
 * Validate the snapshot envelope (a 1-element array whose object carries the
 * four datasets) and extract ONLY the whitelisted fields. Malformed rows are
 * skipped and counted, never fatal. Throws a validation error when the
 * envelope itself is not an SSIS snapshot.
 */
export function extractSsisSnapshot(payload: unknown): SsisExtractedSnapshot {
  if (!Array.isArray(payload) || payload.length === 0 || !isRecord(payload[0])) {
    throw errors.validation(
      "That file is not an SSIS snapshot. Expected the exported JSON with unit purchases, statement, NAV data and NAV history."
    );
  }
  const root = payload[0];
  const { unitPurchase, statement, navData, overallNav } = root;
  if (!Array.isArray(unitPurchase) || !Array.isArray(statement) || !Array.isArray(overallNav)) {
    throw errors.validation(
      "That SSIS snapshot is missing one of its datasets (unit purchases, statement, or NAV history)."
    );
  }

  let skipped = 0;
  const purchaseByKey = new Map<string, SsisPurchaseRow>();
  for (const row of unitPurchase) {
    const parsed = extractPurchase(row);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    purchaseByKey.set(parsed.requestNo, parsed); // uniqueBy: last wins
  }
  const statementByKey = new Map<string, SsisStatementRow>();
  for (const row of statement) {
    const parsed = extractStatementRow(row);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    statementByKey.set(parsed.transNo, parsed);
  }
  const navByDate = new Map<string, SsisNavPoint>();
  for (const row of overallNav) {
    const parsed = extractNavPoint(row);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    navByDate.set(parsed.engDate, parsed);
  }

  const purchaseList = [...purchaseByKey.values()];
  const statementList = [...statementByKey.values()];
  const navList = [...navByDate.values()].sort((a, b) => a.engDate.localeCompare(b.engDate));

  // Individually-safe rows can still sum past exact representation (three
  // purchases of 90,071,992,547,409.91 each are each safe alone). Never
  // persist a snapshot whose totals the read model could only show rounded.
  let totalUnitsScaled = 0n;
  let totalInvested = 0n;
  for (const purchase of purchaseList) {
    totalUnitsScaled += parseDecimalScaled(purchase.units, UNITS_SCALE) ?? 0n;
    totalInvested += BigInt(purchase.amountMinor);
  }
  if (totalUnitsScaled > MAX_SAFE || totalInvested > MAX_SAFE) {
    throw errors.validation(
      "That snapshot's totals are too large for Meridian to represent exactly, so nothing was imported. Check the file and try again."
    );
  }

  // Holder identity is asserted by every holder-bearing dataset, not just
  // purchases. A snapshot whose own datasets disagree about the holder is
  // not a reliable binding and is rejected outright — it can never be
  // merged safely under any single-holder policy.
  const holderNames = distinctHolderNames([...unitPurchase, ...statement]);
  if (holderNames.length > 1) {
    throw errors.validation(
      "That snapshot names more than one holder across its datasets, so nothing was imported. Export a single holder's snapshot and try again."
    );
  }

  return {
    purchases: purchaseList,
    statement: statementList,
    navHistory: navList,
    holderName: holderNames[0] ?? null,
    holderNames,
    navDataNav: extractNavDataNav(navData),
    skipped
  };
}

// ---------------------------------------------------------------------------
// Summary math — mirrors the standalone dashboard (ssis/app/page.jsx):
// total units and invested come from ALL purchase rows; the current NAV is
// the latest NAV-history point not in the future, falling back to the
// GetNAV value captured in state.
// ---------------------------------------------------------------------------

export type SsisSummary = {
  purchaseCount: number;
  totalUnits: string;
  totalInvestedMinor: number | null;
  currentNavMinor: number | null;
  currentNavDate: string | null;
  currentValueMinor: number | null;
  profitMinor: number | null;
  returnPercent: number | null;
};

export function resolveCurrentNav(
  navHistory: SsisNavPoint[],
  stateNav: { navMinor: number; navDate: string } | null,
  today: string
): { navMinor: number; navDate: string } | null {
  let latest: SsisNavPoint | null = null;
  for (const point of navHistory) {
    if (point.engDate <= today && (!latest || point.engDate > latest.engDate)) latest = point;
  }
  if (latest) return { navMinor: latest.navMinor, navDate: latest.engDate };
  return stateNav;
}

function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  // Quantities and NAVs here are non-negative, so half-up is exact.
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function computeSsisSummary(input: {
  purchases: Pick<SsisPurchaseRow, "units" | "amountMinor">[];
  navHistory: SsisNavPoint[];
  stateNav: { navMinor: number; navDate: string } | null;
  today: string;
}): SsisSummary {
  let totalUnitsScaled = 0n;
  let totalInvested = 0n;
  for (const purchase of input.purchases) {
    const parsed = parseDecimalScaled(purchase.units, UNITS_SCALE);
    if (parsed !== null) totalUnitsScaled += parsed;
    totalInvested += BigInt(purchase.amountMinor);
  }
  const currentNav = resolveCurrentNav(input.navHistory, input.stateNav, input.today);
  // Every BigInt → Number conversion is checked: an aggregate that leaves
  // the exactly-representable range surfaces as null (the page shows "—")
  // instead of a silently rounded amount or a non-finite chart value.
  const totalInvestedMinor = toSafeNumber(totalInvested);
  let currentValueMinor: number | null = null;
  let profitMinor: number | null = null;
  let returnPercent: number | null = null;
  if (currentNav) {
    const value = roundHalfUpDiv(totalUnitsScaled * BigInt(currentNav.navMinor), UNITS_FACTOR);
    currentValueMinor = toSafeNumber(value);
    if (currentValueMinor !== null && totalInvestedMinor !== null) {
      profitMinor = currentValueMinor - totalInvestedMinor;
      returnPercent =
        totalInvestedMinor > 0
          ? Math.round((profitMinor / totalInvestedMinor) * 10_000) / 100
          : null;
    }
  }
  return {
    purchaseCount: input.purchases.length,
    totalUnits: unitsText(totalUnitsScaled),
    totalInvestedMinor,
    currentNavMinor: currentNav?.navMinor ?? null,
    currentNavDate: currentNav?.navDate ?? null,
    currentValueMinor,
    profitMinor,
    returnPercent
  };
}

export type SsisNavStats = {
  minNavMinor: number | null;
  maxNavMinor: number | null;
  avgNavMinor: number | null;
  currentNavMinor: number | null;
  changeFromMinPercent: number | null;
};

/** NAV statistics over purchase NAVs, mirroring ssis/app/navdata/page.jsx. */
export function computeSsisNavStats(input: {
  purchases: Pick<SsisPurchaseRow, "purchaseNavMinor">[];
  currentNavMinor: number | null;
}): SsisNavStats {
  const navs = input.purchases
    .map((p) => p.purchaseNavMinor)
    .filter((v): v is number => v !== null);
  if (navs.length === 0) {
    return {
      minNavMinor: null,
      maxNavMinor: null,
      avgNavMinor: null,
      currentNavMinor: input.currentNavMinor,
      changeFromMinPercent: null
    };
  }
  const min = Math.min(...navs);
  const max = Math.max(...navs);
  // Sum in BigInt so the average stays exact for any row count.
  const navSum = navs.reduce((acc, v) => acc + BigInt(v), 0n);
  const avg = Number(roundHalfUpDiv(navSum, BigInt(navs.length)));
  const changeFromMinPercent =
    input.currentNavMinor !== null && min > 0
      ? Math.round(((input.currentNavMinor - min) / min) * 10_000) / 100
      : null;
  return {
    minNavMinor: min,
    maxNavMinor: max,
    avgNavMinor: avg,
    currentNavMinor: input.currentNavMinor,
    changeFromMinPercent
  };
}

export type SsisPurchaseSeriesPoint = {
  date: string;
  units: string;
  purchaseNavMinor: number | null;
};

export type SsisValueGrowthPoint = {
  date: string;
  investedMinor: number | null;
  valueMinor: number | null;
};

export function buildSsisSeries(input: {
  purchases: SsisPurchaseRow[];
  currentNavMinor: number | null;
}): { purchaseSeries: SsisPurchaseSeriesPoint[]; valueGrowth: SsisValueGrowthPoint[] } {
  const sorted = [...input.purchases].sort((a, b) => a.applyDate.localeCompare(b.applyDate));
  const purchaseSeries = sorted.map((p) => ({
    date: p.applyDate,
    units: p.units,
    purchaseNavMinor: p.purchaseNavMinor
  }));
  let cumUnits = 0n;
  let cumInvested = 0n;
  const valueGrowth = sorted.map((p) => {
    const parsed = parseDecimalScaled(p.units, UNITS_SCALE);
    if (parsed !== null) cumUnits += parsed;
    cumInvested += BigInt(p.amountMinor);
    return {
      date: p.applyDate,
      investedMinor: toSafeNumber(cumInvested),
      valueMinor:
        input.currentNavMinor !== null
          ? toSafeNumber(roundHalfUpDiv(cumUnits * BigInt(input.currentNavMinor), UNITS_FACTOR))
          : null
    };
  });
  return { purchaseSeries, valueGrowth };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export type SsisImportCounts = {
  purchases: number;
  statement: number;
  navPoints: number;
  skipped: number;
};

export type SsisSource = "import" | "refresh";

export type SsisImportOptions = {
  /**
   * Refresh commits carry the configuration they fetched for. The commit
   * re-reads the state row inside its transaction and refuses to write
   * when the BO number or config generation has moved on, so a refresh
   * that was in flight across a holder switch cannot repopulate the
   * insight with the previous holder's rows.
   */
  expectedConfig?: { boAccountNo: string; configGeneration: number };
};

/**
 * Serialize SSIS writes per family (the family-import pattern). On the
 * cloud backend the Durable Object already serializes access, so the
 * advisory lock is Postgres-only.
 */
async function lockSsisFamily(tx: Executor, familyId: string): Promise<void> {
  if (!usesCloudStorage) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${familyId}))`);
  }
}

function normalizeHolderName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function importSsisSnapshot(
  exec: Executor,
  actor: Actor,
  payload: unknown,
  source: SsisSource,
  options: SsisImportOptions = {}
): Promise<SsisImportCounts> {
  assertSsisAdmin(actor);
  const data = extractSsisSnapshot(payload);
  const familyId = actor.familyId;
  await exec.transaction(async (tx) => {
    await lockSsisFamily(tx, familyId);
    // Resolve the current NAV on the same household-local date as the
    // page read model. UTC can still be yesterday when a quote is already
    // current for this household; skipping that quote here would persist
    // an overflowing valuation that the page cannot represent.
    const [family] = await tx
      .select({ timezone: families.timezone })
      .from(families)
      .where(eq(families.id, familyId))
      .limit(1);
    const today = todayIn(family?.timezone ?? "UTC");
    const stateNav = data.navDataNav ?? resolveCurrentNav(data.navHistory, null, today);

    // The value this snapshot implies at its own current NAV must also be
    // exactly representable before anything is persisted.
    if (stateNav) {
      let totalUnitsScaled = 0n;
      for (const purchase of data.purchases) {
        totalUnitsScaled += parseDecimalScaled(purchase.units, UNITS_SCALE) ?? 0n;
      }
      const value = roundHalfUpDiv(totalUnitsScaled * BigInt(stateNav.navMinor), UNITS_FACTOR);
      if (toSafeNumber(value) === null) {
        throw errors.validation(
          "That snapshot's current value is too large for Meridian to represent exactly, so nothing was imported. Check the file and try again."
        );
      }
    }

    const [state] = await tx
      .select()
      .from(ssisInsightState)
      .where(eq(ssisInsightState.familyId, familyId))
      .limit(1);
    if (options.expectedConfig) {
      if (
        !state ||
        state.boAccountNo !== options.expectedConfig.boAccountNo ||
        state.configGeneration !== options.expectedConfig.configGeneration
      ) {
        throw errors.validation(
          "The SSIS configuration changed while this data was being fetched, so nothing was updated. Refresh again to load data for the current holder."
        );
      }
    }
    // Holder binding. Every name the incoming snapshot asserts — from any
    // dataset — must match the stored holder. Missing identity is not
    // permission to merge: a file import into an insight that already
    // holds holder data must identify the holder it belongs to. Live
    // refreshes are exempt from the identity requirement (they are bound
    // by the expectedConfig generation check above and may legitimately
    // arrive with some datasets missing), but a refresh whose data names
    // a different holder is still rejected.
    if (state?.holderName) {
      const storedNormalized = normalizeHolderName(state.holderName);
      if (data.holderNames.some((name) => normalizeHolderName(name) !== storedNormalized)) {
        throw errors.validation(
          `This insight already holds data for ${state.holderName}, and this data names a different holder. Nothing was imported — to switch holders, change the BO account number and confirm the switch, which clears the previous holder's data.`
        );
      }
    }
    if (!options.expectedConfig) {
      const [storedPurchase] = await tx
        .select({ id: ssisPurchases.id })
        .from(ssisPurchases)
        .where(eq(ssisPurchases.familyId, familyId))
        .limit(1);
      const [storedStatement] = await tx
        .select({ id: ssisStatementEntries.id })
        .from(ssisStatementEntries)
        .where(eq(ssisStatementEntries.familyId, familyId))
        .limit(1);
      const holdsRows = !!storedPurchase || !!storedStatement;
      if (data.holderNames.length === 0) {
        if (holdsRows || state?.holderName) {
          throw errors.validation(
            "This snapshot does not identify which holder it belongs to, and this insight already holds holder data — nothing was imported. Import the holder's own snapshot export, or switch holders from the BO account settings to start fresh."
          );
        }
      } else if (!state?.holderName && holdsRows) {
        // The mirror case: the stored data was imported WITHOUT a holder
        // identity (holderName still null), so there is no stored holder
        // for the incoming name to match. Merging would silently bind the
        // anonymous rows to the named holder — the admin never confirmed
        // they are the same person's data. Reject and point at the reset
        // path, which clears the unidentified data so the named snapshot
        // can seed the insight on its own. (A live refresh is exempt: it
        // is bound to the configured BO account by the generation check,
        // so the identity it carries is the configured holder's.)
        throw errors.validation(
          `This insight already holds data that was imported without a holder identity, and this snapshot names ${data.holderName}. Nothing was imported — the existing data cannot be silently bound to a named holder. If the existing data should be replaced, change the BO account number in the SSIS settings and confirm the switch to clear it, then import again.`
        );
      }
    }
    for (const purchase of data.purchases) {
      await tx
        .insert(ssisPurchases)
        .values({ familyId, ...purchase })
        .onConflictDoUpdate({
          target: [ssisPurchases.familyId, ssisPurchases.requestNo],
          set: {
            applyDate: purchase.applyDate,
            units: purchase.units,
            amountMinor: purchase.amountMinor,
            status: purchase.status,
            purchaseNavMinor: purchase.purchaseNavMinor,
            navDate: purchase.navDate,
            schemeName: purchase.schemeName,
            isSip: purchase.isSip,
            updatedAt: new Date()
          }
        });
    }
    for (const row of data.statement) {
      await tx
        .insert(ssisStatementEntries)
        .values({ familyId, ...row })
        .onConflictDoUpdate({
          target: [ssisStatementEntries.familyId, ssisStatementEntries.transNo],
          set: {
            installmentDate: row.installmentDate,
            dueDate: row.dueDate,
            actionDate: row.actionDate,
            amountCrMinor: row.amountCrMinor,
            amountDrMinor: row.amountDrMinor,
            units: row.units,
            appliedNavMinor: row.appliedNavMinor,
            payment: row.payment,
            otherChargesMinor: row.otherChargesMinor,
            sebonFeeMinor: row.sebonFeeMinor,
            sipRegNo: row.sipRegNo,
            updatedAt: new Date()
          }
        });
    }
    for (const point of data.navHistory) {
      await tx
        .insert(ssisNavHistory)
        .values({ familyId, ...point })
        .onConflictDoUpdate({
          target: [ssisNavHistory.familyId, ssisNavHistory.engDate],
          set: { nepDate: point.nepDate, navMinor: point.navMinor, updatedAt: new Date() }
        });
    }
    await tx
      .insert(ssisInsightState)
      .values({
        familyId,
        holderName: data.holderName,
        latestNavMinor: stateNav?.navMinor ?? null,
        latestNavDate: stateNav?.navDate ?? null,
        lastFetchedAt: new Date(),
        lastSource: source
      })
      .onConflictDoUpdate({
        target: ssisInsightState.familyId,
        set: {
          ...(data.holderName ? { holderName: data.holderName } : {}),
          ...(stateNav
            ? { latestNavMinor: stateNav.navMinor, latestNavDate: stateNav.navDate }
            : {}),
          lastFetchedAt: new Date(),
          lastSource: source,
          updatedAt: new Date()
        }
      });
    // Effective-dataset bounds. The checks on the incoming fragment (in
    // extraction and above) are a fast path only: what must stay exactly
    // representable is the dataset that remains stored AFTER the upserts.
    // Two individually-safe fragments can combine past the safe range, and
    // a NAV-only update can overflow a stored position it never mentions.
    // Validate the post-upsert totals and the value at the resolved
    // current NAV (stored history/state merged with this commit) inside
    // the same family-locked transaction; throwing here rolls the whole
    // commit back — for file imports and refreshes alike — so an
    // unrepresentable result is never persisted. (Read-side nulls remain
    // the defensive fallback for any legacy rows.)
    const storedPurchases = await tx
      .select({ units: ssisPurchases.units, amountMinor: ssisPurchases.amountMinor })
      .from(ssisPurchases)
      .where(eq(ssisPurchases.familyId, familyId));
    let effectiveUnitsScaled = 0n;
    let effectiveInvested = 0n;
    for (const row of storedPurchases) {
      effectiveUnitsScaled += parseDecimalScaled(row.units, UNITS_SCALE) ?? 0n;
      effectiveInvested += BigInt(row.amountMinor);
    }
    if (effectiveUnitsScaled > MAX_SAFE || effectiveInvested > MAX_SAFE) {
      throw errors.validation(
        "The combined SSIS data for this insight is too large for Meridian to represent exactly, so nothing was imported. The previously stored data is unchanged."
      );
    }
    const storedNavHistory = await tx
      .select({
        engDate: ssisNavHistory.engDate,
        nepDate: ssisNavHistory.nepDate,
        navMinor: ssisNavHistory.navMinor
      })
      .from(ssisNavHistory)
      .where(eq(ssisNavHistory.familyId, familyId));
    const [effectiveState] = await tx
      .select()
      .from(ssisInsightState)
      .where(eq(ssisInsightState.familyId, familyId))
      .limit(1);
    const effectiveStateNav =
      effectiveState?.latestNavMinor != null && effectiveState?.latestNavDate
        ? { navMinor: effectiveState.latestNavMinor, navDate: effectiveState.latestNavDate }
        : null;
    const resolvedNav = resolveCurrentNav(storedNavHistory, effectiveStateNav, today);
    if (resolvedNav) {
      const value = roundHalfUpDiv(
        effectiveUnitsScaled * BigInt(resolvedNav.navMinor),
        UNITS_FACTOR
      );
      if (toSafeNumber(value) === null) {
        throw errors.validation(
          "The stored position's value at the current NAV is too large for Meridian to represent exactly, so nothing was imported. The previously stored data is unchanged."
        );
      }
    }
    await recordAudit(tx, {
      familyId,
      actorUserId: actor.userId,
      action: source === "refresh" ? "ssis.refreshed" : "ssis.imported",
      entityType: "ssis_insight",
      entityId: familyId,
      metadata: {
        source,
        purchases: data.purchases.length,
        statement: data.statement.length,
        navPoints: data.navHistory.length,
        skipped: data.skipped
      }
    });
  });

  return {
    purchases: data.purchases.length,
    statement: data.statement.length,
    navPoints: data.navHistory.length,
    skipped: data.skipped
  };
}

export function maskBoAccountNo(boAccountNo: string | null): string | null {
  if (!boAccountNo) return null;
  return `••••${boAccountNo.slice(-4)}`;
}

export type SsisBoConfigResult = { dataReset: boolean };

/**
 * Configure the BO account number the insight is bound to.
 *
 * Single-holder policy: while the insight holds a previous holder's
 * purchases or statement, changing the number is rejected unless the
 * caller explicitly confirms the switch (`resetExistingData`), in which
 * case the previous holder's datasets are cleared in the same transaction
 * (scheme-level NAV history is kept — it is not holder data). The same
 * rule applies to the FIRST binding when snapshot data was imported
 * before any number was configured: an explicit reset clears the imported
 * data and reports `dataReset`, while without a reset the number simply
 * binds to the imported data and keeps it (the snapshot-first workflow).
 * Every actual change bumps config_generation so an in-flight refresh for the old
 * holder fails its commit check instead of writing under the new holder.
 *
 * Error hygiene: the upsert binds the BO number as a parameter, and ORM /
 * driver errors embed SQL text and bound parameters in their messages.
 * Any non-domain failure from this function is therefore replaced with a
 * sanitized error carrying no cause chain before it can reach generic
 * action logging.
 */
export async function setSsisBoAccountNo(
  exec: Executor,
  actor: Actor,
  boAccountNo: string,
  options: { resetExistingData?: boolean } = {}
): Promise<SsisBoConfigResult> {
  assertSsisAdmin(actor);
  const normalized = boAccountNo.trim();
  if (!/^[0-9]{8,24}$/.test(normalized)) {
    throw errors.validation("Enter the BO account number (digits only, 8–24 characters).");
  }
  try {
    return await exec.transaction(async (tx) => {
      await lockSsisFamily(tx, actor.familyId);
      const [state] = await tx
        .select()
        .from(ssisInsightState)
        .where(eq(ssisInsightState.familyId, actor.familyId))
        .limit(1);
      const previousBo = state?.boAccountNo ?? null;
      const changed = previousBo !== normalized;
      let dataReset = false;
      if (changed) {
        const purchaseRows = await tx
          .select({ id: ssisPurchases.id })
          .from(ssisPurchases)
          .where(eq(ssisPurchases.familyId, actor.familyId));
        const statementRows = await tx
          .select({ id: ssisStatementEntries.id })
          .from(ssisStatementEntries)
          .where(eq(ssisStatementEntries.familyId, actor.familyId));
        const hasHolderData =
          purchaseRows.length > 0 || statementRows.length > 0 || !!state?.holderName;
        if (hasHolderData && options.resetExistingData) {
          // A confirmed switch — including the FIRST binding over
          // snapshot-imported data, where no previous BO exists. An
          // explicit reset is always honored, never silently ignored
          // just because there was no earlier number to switch from.
          await tx.delete(ssisPurchases).where(eq(ssisPurchases.familyId, actor.familyId));
          await tx
            .delete(ssisStatementEntries)
            .where(eq(ssisStatementEntries.familyId, actor.familyId));
          dataReset = true;
        } else if (hasHolderData && previousBo !== null) {
          throw errors.validation(
            "This insight already holds purchases and statement data for the current BO account. Changing the number would mix two holders' data — confirm the switch to clear the existing holder data and start fresh for the new holder."
          );
        }
        // Remaining case: the first BO binding over snapshot-imported
        // data with no reset requested — bind the number to the imported
        // data and keep it (the snapshot-first workflow).
      }
      const configGeneration =
        (state?.configGeneration ?? 0) + (changed && previousBo !== null ? 1 : 0);
      const resetFields = dataReset
        ? { holderName: null, lastFetchedAt: null, lastSource: null }
        : {};
      await tx
        .insert(ssisInsightState)
        .values({
          familyId: actor.familyId,
          boAccountNo: normalized,
          configGeneration,
          ...resetFields
        })
        .onConflictDoUpdate({
          target: ssisInsightState.familyId,
          set: { boAccountNo: normalized, configGeneration, ...resetFields, updatedAt: new Date() }
        });
      await recordAudit(tx, {
        familyId: actor.familyId,
        actorUserId: actor.userId,
        action: "ssis.bo_account_configured",
        entityType: "ssis_insight",
        entityId: actor.familyId,
        metadata: { source: "settings", ...(dataReset ? { dataReset: true } : {}) }
      });
      return { dataReset };
    });
  } catch (e) {
    if (isDomainError(e)) throw e;
    throw new Error("Could not save the SSIS BO account configuration.");
  }
}

export type SsisRefreshResult = SsisImportCounts & { warnings: string[] };

export async function refreshSsis(
  exec: Executor,
  actor: Actor,
  fetchFn?: typeof fetch
): Promise<SsisRefreshResult> {
  assertSsisAdmin(actor);
  const [state] = await exec
    .select()
    .from(ssisInsightState)
    .where(eq(ssisInsightState.familyId, actor.familyId))
    .limit(1);
  const boAccountNo = state?.boAccountNo ?? null;
  if (!boAccountNo) {
    throw errors.validation(
      "Set your BO account number first — refresh needs it to query Siddhartha Capital."
    );
  }
  const configGeneration = state?.configGeneration ?? 0;
  const snapshot = await fetchSsisSnapshot(boAccountNo, fetchFn);
  if (
    snapshot.payload === null ||
    (snapshot.fetched.purchases === 0 &&
      snapshot.fetched.statement === 0 &&
      snapshot.fetched.navPoints === 0 &&
      !snapshot.fetched.hasNavData)
  ) {
    throw errors.validation(
      "Siddhartha Capital returned no SSIS data. Nothing was updated — try again later or import a snapshot file instead."
    );
  }
  const counts = await importSsisSnapshot(exec, actor, snapshot.payload, "refresh", {
    expectedConfig: { boAccountNo, configGeneration }
  });
  return { ...counts, warnings: snapshot.warnings };
}

// ---------------------------------------------------------------------------
// Read model for the insight page
// ---------------------------------------------------------------------------

export type SsisInsightData = {
  hasData: boolean;
  holderName: string | null;
  schemeName: string;
  lastFetchedAt: string | null;
  lastSource: string | null;
  hasBoAccount: boolean;
  boAccountMasked: string | null;
  canManage: boolean;
  currency: string;
  summary: SsisSummary;
  navStats: SsisNavStats;
  purchaseSeries: SsisPurchaseSeriesPoint[];
  valueGrowth: SsisValueGrowthPoint[];
  navSeries: SsisNavPoint[];
  purchases: SsisPurchaseRow[];
  statement: SsisStatementRow[];
};

export async function getSsisInsight(exec: Executor, actor: Actor): Promise<SsisInsightData> {
  const familyId = actor.familyId;
  const [familyRows, stateRows, purchaseRows, statementRows, navRows] = await Promise.all([
    exec
      .select({ timezone: families.timezone })
      .from(families)
      .where(eq(families.id, familyId))
      .limit(1),
    exec.select().from(ssisInsightState).where(eq(ssisInsightState.familyId, familyId)).limit(1),
    exec
      .select()
      .from(ssisPurchases)
      .where(eq(ssisPurchases.familyId, familyId))
      .orderBy(asc(ssisPurchases.applyDate), asc(ssisPurchases.requestNo)),
    exec
      .select()
      .from(ssisStatementEntries)
      .where(eq(ssisStatementEntries.familyId, familyId))
      .orderBy(asc(ssisStatementEntries.installmentDate), asc(ssisStatementEntries.transNo)),
    exec
      .select()
      .from(ssisNavHistory)
      .where(eq(ssisNavHistory.familyId, familyId))
      .orderBy(asc(ssisNavHistory.engDate))
  ]);
  const state = stateRows[0] ?? null;
  const today = todayIn(familyRows[0]?.timezone ?? "UTC");
  const purchases: SsisPurchaseRow[] = purchaseRows.map((row) => ({
    requestNo: row.requestNo,
    applyDate: row.applyDate,
    units: row.units,
    amountMinor: row.amountMinor,
    status: row.status,
    purchaseNavMinor: row.purchaseNavMinor,
    navDate: row.navDate,
    schemeName: row.schemeName,
    isSip: row.isSip
  }));
  const statement: SsisStatementRow[] = statementRows.map((row) => ({
    transNo: row.transNo,
    installmentDate: row.installmentDate,
    dueDate: row.dueDate,
    actionDate: row.actionDate,
    amountCrMinor: row.amountCrMinor,
    amountDrMinor: row.amountDrMinor,
    units: row.units,
    appliedNavMinor: row.appliedNavMinor,
    payment: row.payment,
    otherChargesMinor: row.otherChargesMinor,
    sebonFeeMinor: row.sebonFeeMinor,
    sipRegNo: row.sipRegNo
  }));
  const navHistory: SsisNavPoint[] = navRows.map((row) => ({
    engDate: row.engDate,
    nepDate: row.nepDate,
    navMinor: row.navMinor
  }));
  const stateNav =
    state?.latestNavMinor != null && state?.latestNavDate
      ? { navMinor: state.latestNavMinor, navDate: state.latestNavDate }
      : null;
  const summary = computeSsisSummary({ purchases, navHistory, stateNav, today });
  const navStats = computeSsisNavStats({ purchases, currentNavMinor: summary.currentNavMinor });
  const { purchaseSeries, valueGrowth } = buildSsisSeries({
    purchases,
    currentNavMinor: summary.currentNavMinor
  });
  const schemeName = purchases.find((p) => p.schemeName)?.schemeName ?? SSIS_SCHEME_NAME;
  return {
    hasData: purchases.length > 0 || statement.length > 0 || navHistory.length > 0,
    holderName: state?.holderName ?? null,
    schemeName,
    lastFetchedAt: state?.lastFetchedAt ? new Date(state.lastFetchedAt).toISOString() : null,
    lastSource: state?.lastSource ?? null,
    hasBoAccount: !!state?.boAccountNo,
    boAccountMasked: maskBoAccountNo(state?.boAccountNo ?? null),
    canManage: actor.familyRole === "admin",
    currency: "NPR",
    summary,
    navStats,
    purchaseSeries,
    valueGrowth,
    navSeries: navHistory,
    purchases,
    statement
  };
}
