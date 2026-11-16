import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { actorOf, db, makeUser, truncateAll } from "../helpers";
import {
  getSsisInsight,
  importSsisSnapshot,
  refreshSsis,
  setSsisBoAccountNo
} from "@/server/domain/ssis";
import {
  auditEvents,
  ssisInsightState,
  ssisNavHistory,
  ssisPurchases,
  ssisStatementEntries
} from "@/server/db/schema";
import { buildSsisPayload, SSIS_PII } from "../fixtures/ssis-snapshot";

const BO = "1301000011112222";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

type StubOptions = { failStatement?: boolean };

function stubUpstream(options: StubOptions = {}): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("PurchaseRequesthandler")) {
      const payload = buildSsisPayload() as [{ unitPurchase: unknown[] }];
      return jsonResponse({ ResponseData: payload[0].unitPurchase });
    }
    if (url.includes("HolderStatement")) {
      if (options.failStatement) return jsonResponse({ message: "boom" }, 500);
      const payload = buildSsisPayload() as [{ statement: unknown[] }];
      return jsonResponse({ ResponseData: payload[0].statement });
    }
    if (url.includes("GetNAV")) {
      return jsonResponse({
        ResponseData: [{ Scheme_code: "001", nav_date: "2024-03-20", nav_value: 11.5 }]
      });
    }
    if (url.includes("admin-ajax.php")) {
      return jsonResponse({
        data: [
          { eng_date: "2024-01-31", nep_date: "2080-10-17", nav: "10.10" },
          { eng_date: "2024-03-31", nep_date: "2080-12-17", nav: "11.00" }
        ]
      });
    }
    return jsonResponse({}, 404);
  };
}

describe("SSIS insight (Postgres)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("imports a snapshot into its own tables and computes the insight", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const counts = await importSsisSnapshot(db(), actor, buildSsisPayload(), "import");
    expect(counts).toEqual({ purchases: 3, statement: 2, navPoints: 4, skipped: 3 });

    const insight = await getSsisInsight(db(), actor);
    expect(insight.hasData).toBe(true);
    expect(insight.holderName).toBe("Test Holder");
    expect(insight.schemeName).toBe("Siddhartha Systematic Investment Scheme");
    expect(insight.lastSource).toBe("import");
    expect(insight.summary.totalUnits).toBe("175.75");
    expect(insight.summary.totalInvestedMinor).toBe(177260);
    expect(insight.purchases).toHaveLength(3);
    expect(insight.statement).toHaveLength(2);
    expect(insight.navSeries).toHaveLength(4);

    const audits = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ssis.imported"));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain(SSIS_PII.boAccountNo);
  });

  it("never persists payload PII, and does not adopt the payload BO number", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await importSsisSnapshot(db(), actor, buildSsisPayload(), "import");
    const [purchases, statement, nav, state] = await Promise.all([
      db().select().from(ssisPurchases),
      db().select().from(ssisStatementEntries),
      db().select().from(ssisNavHistory),
      db().select().from(ssisInsightState)
    ]);
    const everything = JSON.stringify({ purchases, statement, nav, state });
    for (const pii of Object.values(SSIS_PII)) {
      expect(everything).not.toContain(pii);
    }
    // The BO number is only ever the user-entered one; the payload's BO
    // field is PII for this feature and must not leak into state.
    expect(state[0]!.boAccountNo).toBeNull();
    expect(state[0]!.holderName).toBe("Test Holder");
    // navData (11.50 on 2024-03-20) is the state's latest NAV.
    expect(state[0]!.latestNavMinor).toBe(1150);
    expect(state[0]!.latestNavDate).toBe("2024-03-20");
  });

  it("is idempotent: importing the same snapshot twice changes nothing", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const first = await importSsisSnapshot(db(), actor, buildSsisPayload(), "import");
    const second = await importSsisSnapshot(db(), actor, buildSsisPayload(), "import");
    expect(second).toEqual(first);
    expect(await db().select().from(ssisPurchases)).toHaveLength(3);
    expect(await db().select().from(ssisStatementEntries)).toHaveLength(2);
    expect(await db().select().from(ssisNavHistory)).toHaveLength(4);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.summary.totalInvestedMinor).toBe(177260);
  });

  it("isolates families: another household sees nothing and cannot see imports", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    await importSsisSnapshot(db(), actorOf(owner), buildSsisPayload(), "import");
    const insight = await getSsisInsight(db(), actorOf(other));
    expect(insight.hasData).toBe(false);
    expect(insight.purchases).toHaveLength(0);
    expect(insight.statement).toHaveLength(0);
    expect(insight.summary.totalInvestedMinor).toBe(0);
  });

  it("requires family admin for import and BO config, but members can view", async () => {
    const owner = await makeUser();
    const admin = actorOf(owner, "admin");
    const member = actorOf(owner, "member");
    await expect(importSsisSnapshot(db(), member, buildSsisPayload(), "import")).rejects.toThrow(
      /family admin/
    );
    await expect(setSsisBoAccountNo(db(), member, BO)).rejects.toThrow(/family admin/);
    await importSsisSnapshot(db(), admin, buildSsisPayload(), "import");
    const insight = await getSsisInsight(db(), member);
    expect(insight.hasData).toBe(true);
    expect(insight.canManage).toBe(false);
  });

  it("stores the BO number masked, and refresh refuses to run without it", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await expect(refreshSsis(db(), actor, stubUpstream())).rejects.toThrow(/BO account number/);
    await setSsisBoAccountNo(db(), actor, BO);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.hasBoAccount).toBe(true);
    expect(insight.boAccountMasked).toBe("••••2222");
    expect(JSON.stringify(insight)).not.toContain(BO);
  });

  it("refreshes from a stubbed upstream and marks the source as refresh", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, BO);
    const result = await refreshSsis(db(), actor, stubUpstream());
    expect(result.warnings).toEqual([]);
    expect(result.purchases).toBe(3);
    expect(result.statement).toBe(2);
    expect(result.navPoints).toBe(2);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.lastSource).toBe("refresh");
    expect(insight.summary.totalUnits).toBe("175.75");
    const audits = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ssis.refreshed"));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain(BO);
  });

  it("refresh keeps partial data with a warning when one dataset fails", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, BO);
    const result = await refreshSsis(db(), actor, stubUpstream({ failStatement: true }));
    expect(result.purchases).toBe(3);
    expect(result.statement).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/statement/i);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(3);
    expect(insight.statement).toHaveLength(0);
  });
});
