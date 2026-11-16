import { asc, eq } from "drizzle-orm";
import type { Executor } from "../db/client";
import {
  families,
  ssisInsightState,
  ssisNavHistory,
  ssisPurchases,
  ssisStatementEntries
} from "../db/schema";
import type { Actor } from "../auth/context";
import { recordAudit } from "../observability/audit";
import { errors } from "@/lib/errors";
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
 */

export const SSIS_SCHEME_NAME = "Siddhartha Systematic Investment Scheme";
export const SSIS_SCHEME_CODE = "001";

const UNITS_SCALE = 4; // units are decimal strings with up to 4dp
const UNITS_FACTOR = 10_000n;

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
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
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

function holderNameOf(rows: unknown[]): string | null {
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const first = textValue(row.FName, 120);
    const last = textValue(row.LName, 120);
    const name = [first, last].filter(Boolean).join(" ").trim();
    if (name !== "") return name;
  }
  return null;
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

  return {
    purchases: [...purchaseByKey.values()],
    statement: [...statementByKey.values()],
    navHistory: [...navByDate.values()].sort((a, b) => a.engDate.localeCompare(b.engDate)),
    holderName: holderNameOf(unitPurchase),
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
  totalInvestedMinor: number;
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
  const totalInvestedMinor = Number(totalInvested);
  let currentValueMinor: number | null = null;
  let profitMinor: number | null = null;
  let returnPercent: number | null = null;
  if (currentNav) {
    const value = roundHalfUpDiv(totalUnitsScaled * BigInt(currentNav.navMinor), UNITS_FACTOR);
    currentValueMinor = Number(value);
    profitMinor = currentValueMinor - totalInvestedMinor;
    returnPercent =
      totalInvestedMinor > 0 ? Math.round((profitMinor / totalInvestedMinor) * 10_000) / 100 : null;
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
  const avg = Math.round(navs.reduce((a, b) => a + b, 0) / navs.length);
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
  investedMinor: number;
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
      investedMinor: Number(cumInvested),
      valueMinor:
        input.currentNavMinor !== null
          ? Number(roundHalfUpDiv(cumUnits * BigInt(input.currentNavMinor), UNITS_FACTOR))
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

export async function importSsisSnapshot(
  exec: Executor,
  actor: Actor,
  payload: unknown,
  source: SsisSource
): Promise<SsisImportCounts> {
  assertSsisAdmin(actor);
  const data = extractSsisSnapshot(payload);
  const familyId = actor.familyId;
  const today = new Date().toISOString().slice(0, 10);
  const stateNav = data.navDataNav ?? resolveCurrentNav(data.navHistory, null, today);

  await exec.transaction(async (tx) => {
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

export async function setSsisBoAccountNo(
  exec: Executor,
  actor: Actor,
  boAccountNo: string
): Promise<void> {
  assertSsisAdmin(actor);
  const normalized = boAccountNo.trim();
  if (!/^[0-9]{8,24}$/.test(normalized)) {
    throw errors.validation("Enter the BO account number (digits only, 8–24 characters).");
  }
  await exec
    .insert(ssisInsightState)
    .values({ familyId: actor.familyId, boAccountNo: normalized })
    .onConflictDoUpdate({
      target: ssisInsightState.familyId,
      set: { boAccountNo: normalized, updatedAt: new Date() }
    });
  await recordAudit(exec, {
    familyId: actor.familyId,
    actorUserId: actor.userId,
    action: "ssis.bo_account_configured",
    entityType: "ssis_insight",
    entityId: actor.familyId,
    metadata: { source: "settings" }
  });
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
  const counts = await importSsisSnapshot(exec, actor, snapshot.payload, "refresh");
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
