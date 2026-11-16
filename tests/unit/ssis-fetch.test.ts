import { describe, expect, it } from "vitest";
import { fetchSsisSnapshot } from "@/server/domain/ssis-fetch";
import { buildSsisPayload } from "../fixtures/ssis-snapshot";

const BO = "1301000011112222";

/** The application-error envelope the holder handlers return with HTTP 200. */
const APP_ERROR_BODY = { IsSucess: false, ResponseData: null, success: false, data: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

type StubOptions = {
  purchasesBody?: unknown;
  statementBody?: unknown;
  navBody?: unknown;
  wpBody?: unknown;
};

function stubUpstream(options: StubOptions = {}): typeof fetch {
  return async (input) => {
    const url = String(input);
    const payload = buildSsisPayload() as [
      { unitPurchase: unknown[]; statement: unknown[]; navData: unknown }
    ];
    if (url.includes("PurchaseRequesthandler")) {
      return jsonResponse(options.purchasesBody ?? { ResponseData: payload[0].unitPurchase });
    }
    if (url.includes("HolderStatement")) {
      return jsonResponse(options.statementBody ?? { ResponseData: payload[0].statement });
    }
    if (url.includes("GetNAV")) {
      return jsonResponse(
        options.navBody ?? {
          ResponseData: [{ Scheme_code: "001", nav_date: "2024-03-20", nav_value: 11.5 }]
        }
      );
    }
    if (url.includes("admin-ajax.php")) {
      return jsonResponse(
        options.wpBody ?? {
          data: [{ eng_date: "2024-01-31", nep_date: "2080-10-17", nav: "10.10" }]
        }
      );
    }
    return jsonResponse({}, 404);
  };
}

describe("SSIS fetch envelope validation", () => {
  it("treats an HTTP-200 application-error envelope as failure for every dataset", async () => {
    const result = await fetchSsisSnapshot(
      BO,
      stubUpstream({
        purchasesBody: APP_ERROR_BODY,
        statementBody: APP_ERROR_BODY,
        navBody: APP_ERROR_BODY,
        wpBody: APP_ERROR_BODY
      })
    );
    expect(result.payload).toBeNull();
    expect(result.fetched).toEqual({ purchases: 0, statement: 0, navPoints: 0, hasNavData: false });
    expect(result.warnings).toHaveLength(4);
  });

  it("warns for the one application-error dataset and keeps the rest", async () => {
    const result = await fetchSsisSnapshot(BO, stubUpstream({ purchasesBody: APP_ERROR_BODY }));
    expect(result.payload).not.toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Unit purchases/);
    expect(result.fetched.purchases).toBe(0);
    // Raw deduped rows at fetch level (extraction at import drops malformed ones).
    expect(result.fetched.statement).toBe(3);
    expect(result.fetched.hasNavData).toBe(true);
  });

  it("rejects a holder response whose ResponseData is not an array, even when flagged successful", async () => {
    const result = await fetchSsisSnapshot(
      BO,
      stubUpstream({ statementBody: { IsSucess: true, ResponseData: null } })
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/SIP statement/);
    expect(result.fetched.statement).toBe(0);
    expect(result.fetched.purchases).toBe(4);
  });

  it("does not count an arbitrary HTTP-200 object as a current NAV", async () => {
    for (const navBody of [
      { hello: "world" },
      { ResponseData: [] },
      { ResponseData: [{ nav_value: "not-a-number", nav_date: "2024-03-20" }] },
      { ResponseData: [{ nav_value: 11.5, nav_date: "20/03/2024" }] },
      { IsSucess: false, ResponseData: [{ nav_value: 11.5, nav_date: "2024-03-20" }] }
    ]) {
      const result = await fetchSsisSnapshot(BO, stubUpstream({ navBody }));
      expect(result.fetched.hasNavData).toBe(false);
      expect(result.warnings.some((w) => /Current NAV/.test(w))).toBe(true);
      // The other datasets still come back.
      expect(result.payload).not.toBeNull();
      expect(result.fetched.purchases).toBe(4);
    }
  });

  it("accepts a legitimately empty dataset as success, distinct from an error", async () => {
    const result = await fetchSsisSnapshot(
      BO,
      stubUpstream({
        purchasesBody: { IsSucess: true, ResponseData: [] },
        statementBody: { IsSucess: true, ResponseData: [] },
        wpBody: { success: true, data: [] }
      })
    );
    expect(result.warnings).toEqual([]);
    expect(result.payload).not.toBeNull();
    expect(result.fetched).toEqual({ purchases: 0, statement: 0, navPoints: 0, hasNavData: true });
  });

  it("never includes upstream response content in warnings", async () => {
    const result = await fetchSsisSnapshot(
      BO,
      stubUpstream({
        purchasesBody: { IsSucess: false, ResponseData: null, Message: "secret upstream detail" }
      })
    );
    expect(JSON.stringify(result.warnings)).not.toContain("secret upstream detail");
    expect(JSON.stringify(result)).not.toContain(BO);
  });
});
