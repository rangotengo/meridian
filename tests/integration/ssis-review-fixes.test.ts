import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { actorOf, db, makeUser, truncateAll } from "../helpers";
import {
  getSsisInsight,
  importSsisSnapshot,
  refreshSsis,
  setSsisBoAccountNo
} from "@/server/domain/ssis";
import { runAction } from "@/server/actions/runner";
import { log } from "@/lib/logger";
import {
  auditEvents,
  ssisInsightState,
  ssisPurchases,
  ssisStatementEntries
} from "@/server/db/schema";
import { buildSsisPayload } from "../fixtures/ssis-snapshot";

const BO_A = "1301000011112222";
const BO_B = "1301000033334444";
const BO_C = "1301000055556666";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const APP_ERROR_BODY = { IsSucess: false, ResponseData: null, success: false, data: [] };

type StubOptions = { purchasesAppError?: boolean; allAppError?: boolean };

function stubUpstream(options: StubOptions = {}): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (options.allAppError) {
      return jsonResponse(
        url.includes("admin-ajax.php") ? { success: false, data: [] } : APP_ERROR_BODY
      );
    }
    if (url.includes("PurchaseRequesthandler")) {
      if (options.purchasesAppError) return jsonResponse(APP_ERROR_BODY);
      const payload = buildSsisPayload() as [{ unitPurchase: unknown[] }];
      return jsonResponse({ ResponseData: payload[0].unitPurchase });
    }
    if (url.includes("HolderStatement")) {
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
        data: [{ eng_date: "2024-01-31", nep_date: "2080-10-17", nav: "10.10" }]
      });
    }
    return jsonResponse({}, 404);
  };
}

function holderPayload(first: string, last: string, requestNo: number): unknown {
  return [
    {
      unitPurchase: [
        {
          REQUEST_NO: requestNo,
          FName: first,
          LName: last,
          APPLY_DT: "2024-01-15",
          APPLY_UNIT: "10",
          AMOUNT: "100.00",
          APPSTATUS: "VERIFIED",
          current_nav: 10,
          nav_date: "2024-01-15",
          SchemeName: "Siddhartha Systematic Investment Scheme",
          Is_SIP: true
        }
      ],
      statement: [],
      navData: {
        IsSucess: true,
        ResponseData: [{ Scheme_code: "001", nav_date: "2024-03-20", nav_value: 11.5 }]
      },
      overallNav: [{ eng_date: "2024-01-31", nep_date: "2080-10-17", nav: "10.10" }]
    }
  ];
}

describe("SSIS review fixes — holder binding (Postgres)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("rejects an unconfirmed BO switch while holder data exists, and clears data on a confirmed switch", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, BO_A);
    await importSsisSnapshot(db(), actor, buildSsisPayload(), "import");

    // Unconfirmed switch: rejected, and nothing changes.
    await expect(setSsisBoAccountNo(db(), actor, BO_B)).rejects.toThrow(/confirm the switch/);
    let insight = await getSsisInsight(db(), actor);
    expect(insight.boAccountMasked).toBe("••••2222");
    expect(insight.purchases).toHaveLength(3);
    expect(insight.holderName).toBe("Test Holder");

    // Confirmed switch: previous holder's datasets are cleared atomically,
    // scheme-level NAV history is kept.
    const result = await setSsisBoAccountNo(db(), actor, BO_B, { resetExistingData: true });
    expect(result.dataReset).toBe(true);
    insight = await getSsisInsight(db(), actor);
    expect(insight.boAccountMasked).toBe("••••4444");
    expect(insight.purchases).toHaveLength(0);
    expect(insight.statement).toHaveLength(0);
    expect(insight.holderName).toBeNull();
    expect(insight.lastSource).toBeNull();
    expect(insight.navSeries).toHaveLength(4);

    // The new holder's snapshot now imports cleanly (no name clash).
    const counts = await importSsisSnapshot(
      db(),
      actor,
      holderPayload("Second", "Holder", 7001),
      "import"
    );
    expect(counts.purchases).toBe(1);
    insight = await getSsisInsight(db(), actor);
    expect(insight.holderName).toBe("Second Holder");
    expect(insight.summary.totalUnits).toBe("10");

    // A second sequential switch behaves the same way.
    await expect(setSsisBoAccountNo(db(), actor, BO_C)).rejects.toThrow(/confirm the switch/);
    const again = await setSsisBoAccountNo(db(), actor, BO_C, { resetExistingData: true });
    expect(again.dataReset).toBe(true);
    insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(0);
    expect(insight.boAccountMasked).toBe("••••6666");

    // No audit record ever carries a BO number.
    const audits = await db().select().from(auditEvents);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(BO_A);
    expect(serialized).not.toContain(BO_B);
    expect(serialized).not.toContain(BO_C);
  });

  it("allows a BO change before any holder data exists, and re-saving the same number keeps data", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, BO_A);
    const changed = await setSsisBoAccountNo(db(), actor, BO_B);
    expect(changed.dataReset).toBe(false);
    await importSsisSnapshot(db(), actor, buildSsisPayload(), "import");
    const same = await setSsisBoAccountNo(db(), actor, BO_B);
    expect(same.dataReset).toBe(false);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(3);
    expect(insight.boAccountMasked).toBe("••••4444");
  });

  it("rejects a snapshot import that names a different holder than the stored data", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await importSsisSnapshot(db(), actor, buildSsisPayload(), "import");
    await expect(
      importSsisSnapshot(db(), actor, holderPayload("Other", "Person", 8001), "import")
    ).rejects.toThrow(/different holder/);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(3);
    expect(insight.holderName).toBe("Test Holder");
    // The same holder (case/whitespace-insensitive) still imports fine.
    const counts = await importSsisSnapshot(
      db(),
      actor,
      holderPayload("test", "holder", 8002),
      "import"
    );
    expect(counts.purchases).toBe(1);
  });

  it("cannot commit a refresh that was in flight across a confirmed holder switch", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, BO_A);
    await importSsisSnapshot(db(), actor, buildSsisPayload(), "import");

    const upstream = stubUpstream();
    let switched = false;
    const fetchFn: typeof fetch = async (input, init) => {
      if (!switched) {
        switched = true;
        // The admin switches holders while the refresh is still fetching.
        await setSsisBoAccountNo(db(), actor, BO_B, { resetExistingData: true });
      }
      return upstream(input, init);
    };
    await expect(refreshSsis(db(), actor, fetchFn)).rejects.toThrow(/configuration changed/);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.boAccountMasked).toBe("••••4444");
    // The old holder's rows were not repopulated under the new configuration.
    expect(insight.purchases).toHaveLength(0);
    expect(insight.statement).toHaveLength(0);
    expect(insight.holderName).toBeNull();
  });

  it("cannot commit a refresh after a plain BO change, even with no stored data", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, BO_A);
    const upstream = stubUpstream();
    let switched = false;
    const fetchFn: typeof fetch = async (input, init) => {
      if (!switched) {
        switched = true;
        await setSsisBoAccountNo(db(), actor, BO_B);
      }
      return upstream(input, init);
    };
    await expect(refreshSsis(db(), actor, fetchFn)).rejects.toThrow(/configuration changed/);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(0);
    expect(insight.lastSource).toBeNull();
  });

  it("still commits a refresh when the configuration did not change mid-flight", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, BO_A);
    const result = await refreshSsis(db(), actor, stubUpstream());
    expect(result.purchases).toBe(3);
    // Re-saving the same BO number mid-flight must not invalidate a refresh.
    const upstream = stubUpstream();
    let resaved = false;
    const fetchFn: typeof fetch = async (input, init) => {
      if (!resaved) {
        resaved = true;
        await setSsisBoAccountNo(db(), actor, BO_A);
      }
      return upstream(input, init);
    };
    const second = await refreshSsis(db(), actor, fetchFn);
    expect(second.purchases).toBe(3);
  });
});

describe("SSIS review fixes — upstream validation (Postgres)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("refresh against an HTTP-200 application-error upstream updates nothing", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, BO_A);
    await expect(refreshSsis(db(), actor, stubUpstream({ allAppError: true }))).rejects.toThrow(
      /no SSIS data/
    );
    const [state] = await db().select().from(ssisInsightState);
    expect(state!.lastFetchedAt).toBeNull();
    expect(state!.lastSource).toBeNull();
    expect(await db().select().from(ssisPurchases)).toHaveLength(0);
    const audits = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ssis.refreshed"));
    expect(audits).toHaveLength(0);
  });

  it("refresh warns when one dataset returns an application error and imports the rest", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, BO_A);
    const result = await refreshSsis(db(), actor, stubUpstream({ purchasesAppError: true }));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Unit purchases/);
    expect(result.purchases).toBe(0);
    expect(result.statement).toBe(2);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(0);
    expect(insight.statement).toHaveLength(2);
    expect(insight.lastSource).toBe("refresh");
  });
});

describe("SSIS review fixes — BO error hygiene (Postgres)", () => {
  const FAULT_BO = "1301777666555444";

  beforeEach(async () => {
    await truncateAll();
  });

  afterEach(async () => {
    await db().execute(
      sql.raw("ALTER TABLE ssis_insight_state DROP CONSTRAINT IF EXISTS ssis_state_fault_check")
    );
    vi.restoreAllMocks();
  });

  it("never logs the BO number when saving it fails at the database", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    // Fault injection: the real write path fails at the database, the same
    // way the review probe forced it.
    await db().execute(
      sql.raw(
        `ALTER TABLE ssis_insight_state ADD CONSTRAINT ssis_state_fault_check CHECK (bo_account_no IS NULL OR bo_account_no <> '${FAULT_BO}')`
      )
    );

    const result = await runAction("ssis.configure_bo", () =>
      setSsisBoAccountNo(db(), actor, FAULT_BO)
    );
    expect(result.ok).toBe(false);

    // The action failure was logged — but the payload cannot contain the BO.
    const errorCalls = errorSpy.mock.calls.map((call) => call[0]);
    const failed = errorCalls.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).action === "ssis.configure_bo"
    );
    expect(failed.length).toBeGreaterThan(0);
    const logged = JSON.stringify([...errorSpy.mock.calls, ...warnSpy.mock.calls]);
    expect(logged).not.toContain(FAULT_BO);

    // The domain error itself is sanitized, including its whole cause chain.
    const thrown: unknown = await setSsisBoAccountNo(db(), actor, FAULT_BO).catch(
      (e: unknown) => e
    );
    expect(thrown).toBeInstanceOf(Error);
    const chain: string[] = [];
    let cursor: unknown = thrown;
    while (cursor instanceof Error) {
      chain.push(cursor.message);
      cursor = cursor.cause;
    }
    expect(chain.join("\n")).toMatch(/Could not save the SSIS BO account configuration/);
    expect(chain.join("\n")).not.toContain(FAULT_BO);
  });
});

describe("SSIS review fixes — representation bounds (Postgres)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("rejects a snapshot whose individually-safe purchases overflow the invested total", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const row = (requestNo: number) => ({
      REQUEST_NO: requestNo,
      FName: "Test",
      LName: "Holder",
      APPLY_DT: "2024-01-15",
      APPLY_UNIT: "10",
      AMOUNT: "90071992547409.91",
      APPSTATUS: "VERIFIED",
      current_nav: 10,
      nav_date: "2024-01-15"
    });
    const payload = [
      { unitPurchase: [row(1), row(2), row(3)], statement: [], navData: {}, overallNav: [] }
    ];
    await expect(importSsisSnapshot(db(), actor, payload, "import")).rejects.toThrow(/too large/);
    expect(await db().select().from(ssisPurchases)).toHaveLength(0);
    expect(await db().select().from(ssisInsightState)).toHaveLength(0);
  });

  it("rejects a snapshot whose units × NAV value cannot be represented exactly", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const payload = [
      {
        unitPurchase: [
          {
            REQUEST_NO: 9101,
            FName: "Test",
            LName: "Holder",
            APPLY_DT: "2024-01-15",
            // Scales to exactly MAX_SAFE_INTEGER: individually acceptable.
            APPLY_UNIT: "900719925474.0991",
            AMOUNT: "100.00",
            APPSTATUS: "VERIFIED",
            current_nav: "90071992547409.91",
            nav_date: "2024-01-15"
          }
        ],
        statement: [],
        navData: {
          IsSucess: true,
          ResponseData: [
            { Scheme_code: "001", nav_date: "2024-03-20", nav_value: "90071992547409.91" }
          ]
        },
        overallNav: []
      }
    ];
    await expect(importSsisSnapshot(db(), actor, payload, "import")).rejects.toThrow(/too large/);
    expect(await db().select().from(ssisPurchases)).toHaveLength(0);
    expect(await db().select().from(ssisStatementEntries)).toHaveLength(0);
  });
});
