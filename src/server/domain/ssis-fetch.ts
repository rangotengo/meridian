import { log } from "@/lib/logger";

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

function responseDataRows(body: unknown): unknown[] {
  if (!isRecord(body) || !Array.isArray(body.ResponseData)) return [];
  return body.ResponseData;
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

  const purchasesBody = await attempt("purchases", "Unit purchases", () =>
    fetchJson(
      fetchFn,
      "purchases",
      `${MF_BASE}/Handler/RequestHandling/PurchaseRequesthandler.ashx?method=GetHolderUnitRpt&${holderQuery}`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      timeoutMs
    )
  );

  const statementBody = await attempt("statement", "SIP statement", () =>
    fetchJson(
      fetchFn,
      "statement",
      `${MF_BASE}/Handler/SIPHandling/HolderStatement.ashx?method=GetHolderStatement&${holderQuery}`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      timeoutMs
    )
  );

  const navBody = await attempt("nav", "Current NAV", () =>
    fetchJson(
      fetchFn,
      "nav",
      `${MF_BASE}/Handler/SIPHandling/SIP_RegistrationHandler.ashx?method=GetNAV&Scheme_code=${SCHEME_CODE}&ApplyDate=${today}`,
      { method: "GET", headers: { "Content-Type": "application/json" } },
      timeoutMs
    )
  );

  const navHistory = await attempt("navHistory", "Monthly NAV history", async () => {
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
        return isRecord(body) && Array.isArray(body.data) ? body.data : [];
      })
    );
    return perYear.flat();
  });

  const unitPurchase = purchasesBody
    ? uniqueBy(responseDataRows(purchasesBody), (row) =>
        isRecord(row) ? row.REQUEST_NO : undefined
      )
    : [];
  const statement = statementBody
    ? uniqueBy(responseDataRows(statementBody), (row) => (isRecord(row) ? row.trans_no : undefined))
    : [];
  const overallNav = navHistory ?? [];
  const hasNavData = navBody !== null && isRecord(navBody);

  const fetched = {
    purchases: unitPurchase.length,
    statement: statement.length,
    navPoints: overallNav.length,
    hasNavData
  };
  if (
    fetched.purchases === 0 &&
    fetched.statement === 0 &&
    fetched.navPoints === 0 &&
    !fetched.hasNavData
  ) {
    return { payload: null, warnings, fetched };
  }
  return {
    payload: [
      {
        unitPurchase,
        statement,
        navData: hasNavData ? navBody : {},
        overallNav
      }
    ],
    warnings,
    fetched
  };
}
