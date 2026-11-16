import { log } from "@/lib/logger";
import { isIsoDate } from "@/lib/datetime";

/**
 * Live fetcher for the SSIS insight, replicating the owner's standalone
 * server (server/api.js): the two mutualfund.siddharthacapital.com holder
 * handlers, the GetNAV handler, and the siddharthacapital.com WordPress
 * monthly NAV history (scheme_data_filter, BS years 2080–2083).
 *
 * Each dataset is fetched independently (the MeroShare pattern): a failure
 * produces a warning and the remaining datasets still come back. The BO
 * account number is a personal identifier — it is used only to build the
 * upstream query server-side and is never logged, never included in error
 * messages, and never returned to the client. Raw payloads are likewise
 * never logged.
 */

const MF_BASE = "https://mutualfund.siddharthacapital.com";
const WP_AJAX_URL = "https://www.siddharthacapital.com/wp-admin/admin-ajax.php";
const SCHEME_CODE = "001";
const CCODE = "1000";
const COMPANY_ID = "001";
const WP_SCHEME_ID = "3";
const WP_NAV_YEARS = [2080, 2081, 2082, 2083];
// The WordPress nonce shipped with the standalone app. It may be stale —
// the monthly-history dataset degrades to a warning when it is rejected.
const WP_NONCE = "41527efcdc";
const HISTORY_START_DATE = "2020-03-04";
const DEFAULT_TIMEOUT_MS = 15_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type SsisFetchResult = {
  /** Snapshot envelope ready for importSsisSnapshot, or null when nothing could be fetched. */
  payload: unknown | null;
  warnings: string[];
  fetched: { purchases: number; statement: number; navPoints: number; hasNavData: boolean };
};

type Stage = "purchases" | "statement" | "nav" | "navHistory";

function uniqueBy<T>(rows: T[], key: (row: T) => unknown): T[] {
  const map = new Map<unknown, T>();
  for (const row of rows) {
    const value = key(row);
    if (value !== null && value !== undefined) map.set(value, row);
  }
  return [...map.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchJson(
  fetchFn: FetchLike,
  stage: Stage,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<unknown> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      log.warn(
        {
          action: "ssis.upstream",
          stage,
          status: response.status,
          durationMs: Date.now() - startedAt
        },
        "ssis.upstream.http_error"
      );
      throw new Error(`Upstream responded with HTTP ${response.status}.`);
    }
    const body: unknown = await response.json();
    log.info(
      {
        action: "ssis.upstream",
        stage,
        status: response.status,
        durationMs: Date.now() - startedAt
      },
      "ssis.upstream.ok"
    );
    return body;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Upstream responded")) throw error;
    log.warn(
      { action: "ssis.upstream", stage, durationMs: Date.now() - startedAt },
      "ssis.upstream.failed"
    );
    throw new Error("Upstream request failed.");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upstream envelope validation. The holder handlers answer HTTP 200 even
 * for application-level failures (an envelope whose success flag is false
 * and whose ResponseData is null), so a 200 alone proves nothing: each
 * dataset is only counted as fetched after its envelope and data shape
 * check out. A legitimately empty dataset (success envelope, empty
 * ResponseData array) stays distinguishable from an error. Validation
 * errors carry no response content — bodies are never logged or surfaced.
 */
const SUCCESS_FLAG_KEYS = ["IsSucess", "IsSuccess", "Success", "success"] as const;

function assertEnvelopeOk(body: Record<string, unknown>): void {
  for (const key of SUCCESS_FLAG_KEYS) {
    const flag = body[key];
    if (flag === false || (typeof flag === "string" && flag.trim().toLowerCase() === "false")) {
      throw new Error("Upstream reported an application error.");
    }
  }
}

/** Holder datasets must carry a ResponseData array (possibly empty). */
function holderDataRows(body: unknown): unknown[] {
  if (!isRecord(body)) throw new Error("Upstream returned an unexpected response.");
  assertEnvelopeOk(body);
  if (!Array.isArray(body.ResponseData)) {
    throw new Error("Upstream returned an unexpected response.");
  }
  return body.ResponseData;
}

/** 2dp-scaled parse mirroring the domain's NAV extraction (minor units). */
function navMinorOf(value: unknown): bigint | null {
  let raw: string | null = null;
  if (typeof value === "number") raw = Number.isFinite(value) ? String(value) : null;
  else if (typeof value === "string") raw = value.trim().replace(/,/g, "") || null;
  if (raw === null) return null;
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) return null;
  const intPart = match[2] ?? "";
  const frac = match[3] ?? "";
  if (intPart === "" && frac === "") return null;
  let scaled = BigInt(intPart === "" ? "0" : intPart) * 100n;
  if (frac.length <= 2) {
    scaled += BigInt(frac.padEnd(2, "0") || "0");
  } else {
    scaled += BigInt(frac.slice(0, 2) || "0");
    if (frac[2]! >= "5") scaled += 1n;
  }
  return match[1] === "-" ? -scaled : scaled;
}

/**
 * The current-NAV dataset only counts when a valid NAV value and date can
 * actually be extracted from it — an arbitrary HTTP-200 object is not a NAV.
 */
function assertValidNavData(body: unknown): void {
  if (!isRecord(body)) throw new Error("Upstream returned an unexpected response.");
  assertEnvelopeOk(body);
  const responseData = body.ResponseData;
  const first = Array.isArray(responseData) ? responseData[0] : responseData;
  if (!isRecord(first)) throw new Error("Upstream returned no valid NAV.");
  const navMinor = navMinorOf(first.nav_value);
  const navDate = typeof first.nav_date === "string" ? first.nav_date.trim().slice(0, 10) : "";
  if (
    navMinor === null ||
    navMinor < 0n ||
    navMinor > BigInt(Number.MAX_SAFE_INTEGER) ||
    !isIsoDate(navDate)
  ) {
    throw new Error("Upstream returned no valid NAV.");
  }
}

/** The WordPress monthly-history dataset must carry a data array. */
function wpNavHistoryRows(body: unknown): unknown[] {
  if (!isRecord(body)) throw new Error("Upstream returned an unexpected response.");
  assertEnvelopeOk(body);
  if (!Array.isArray(body.data)) throw new Error("Upstream returned an unexpected response.");
  return body.data;
}

export async function fetchSsisSnapshot(
  boAccountNo: string,
  fetchFn: FetchLike = fetch,
  options: { today?: string; timeoutMs?: number } = {}
): Promise<SsisFetchResult> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warnings: string[] = [];

  const holderQuery =
    `scheme_code=${SCHEME_CODE}&Bo_Account_No=${encodeURIComponent(boAccountNo)}` +
    `&ccode=${CCODE}&l_company_id=${COMPANY_ID}&startdate=${HISTORY_START_DATE}&enddate=${today}`;

  const attempt = async <T>(
    stage: Stage,
    label: string,
    run: () => Promise<T>
  ): Promise<T | null> => {
    try {
      return await run();
    } catch {
      warnings.push(`${label} could not be retrieved from Siddhartha Capital.`);
      return null;
    }
  };

  const purchasesRows = await attempt("purchases", "Unit purchases", async () => {
    const body = await fetchJson(
      fetchFn,
      "purchases",
      `${MF_BASE}/Handler/RequestHandling/PurchaseRequesthandler.ashx?method=GetHolderUnitRpt&${holderQuery}`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      timeoutMs
    );
    return uniqueBy(holderDataRows(body), (row) => (isRecord(row) ? row.REQUEST_NO : undefined));
  });

  const statementRows = await attempt("statement", "SIP statement", async () => {
    const body = await fetchJson(
      fetchFn,
      "statement",
      `${MF_BASE}/Handler/SIPHandling/HolderStatement.ashx?method=GetHolderStatement&${holderQuery}`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      timeoutMs
    );
    return uniqueBy(holderDataRows(body), (row) => (isRecord(row) ? row.trans_no : undefined));
  });

  const navBody = await attempt("nav", "Current NAV", async () => {
    const body = await fetchJson(
      fetchFn,
      "nav",
      `${MF_BASE}/Handler/SIPHandling/SIP_RegistrationHandler.ashx?method=GetNAV&Scheme_code=${SCHEME_CODE}&ApplyDate=${today}`,
      { method: "GET", headers: { "Content-Type": "application/json" } },
      timeoutMs
    );
    assertValidNavData(body);
    return body;
  });

  const navHistoryRows = await attempt("navHistory", "Monthly NAV history", async () => {
    const perYear = await Promise.all(
      WP_NAV_YEARS.map(async (year) => {
        const form = new FormData();
        form.set("action", "scheme_data_filter");
        form.set("scheme_id", WP_SCHEME_ID);
        form.set("type", "monthly");
        form.set("year", String(year));
        const body = await fetchJson(
          fetchFn,
          "navHistory",
          WP_AJAX_URL,
          { method: "POST", headers: { "X-WP-Nonce": WP_NONCE }, body: form },
          timeoutMs
        );
        return wpNavHistoryRows(body);
      })
    );
    return perYear.flat();
  });

  const fetched = {
    purchases: purchasesRows?.length ?? 0,
    statement: statementRows?.length ?? 0,
    navPoints: navHistoryRows?.length ?? 0,
    hasNavData: navBody !== null
  };
  // Nothing validated at all: no dataset actually succeeded, so there is
  // no snapshot to import and the caller must leave refresh state untouched.
  if (
    purchasesRows === null &&
    statementRows === null &&
    navBody === null &&
    navHistoryRows === null
  ) {
    return { payload: null, warnings, fetched };
  }
  return {
    payload: [
      {
        unitPurchase: purchasesRows ?? [],
        statement: statementRows ?? [],
        navData: navBody ?? {},
        overallNav: navHistoryRows ?? []
      }
    ],
    warnings,
    fetched
  };
}
