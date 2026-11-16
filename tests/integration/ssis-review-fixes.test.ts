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
  ssisNavHistory,
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

/** A snapshot whose only holder identity lives in the statement dataset. */
function statementOnlyPayload(name: string, transNo: string): unknown {
  return [
    {
      unitPurchase: [],
      statement: [
        {
          scheme_code: "001",
          ccode: "1000",
          SIP_Reg_No: "SIP0001",
          trans_no: transNo,
          installmentDate: "2024-01-15",
          dueDate: null,
          actionDate: "2024-01-16",
          Amount_cr: "100.00",
          Amount_dr: "-",
          unit: "10",
          appnav: "10.00",
          payment: "E-Sewa",
          otherCharges: "0",
          sebon_fee: "0",
          Name: name
        }
      ],
      navData: {
        IsSucess: true,
        ResponseData: [{ Scheme_code: "001", nav_date: "2024-03-20", nav_value: 11.5 }]
      },
      overallNav: [{ eng_date: "2024-01-31", nep_date: "2080-10-17", nav: "10.10" }]
    }
  ];
}

/** A snapshot carrying no holder identity in any dataset. */
function anonymousPayload(requestNo: number): unknown {
  return [
    {
      unitPurchase: [
        {
          REQUEST_NO: requestNo,
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
      navData: {},
      overallNav: []
    }
  ];
}

function bigPurchasePayload(options: {
  requestNo: number;
  amount: string;
  units: string;
  navValue?: string;
}): unknown {
  return [
    {
      unitPurchase: [
        {
          REQUEST_NO: options.requestNo,
          FName: "Test",
          LName: "Holder",
          APPLY_DT: "2024-01-15",
          APPLY_UNIT: options.units,
          AMOUNT: options.amount,
          APPSTATUS: "VERIFIED",
          current_nav: 10,
          nav_date: "2024-01-15",
          SchemeName: "Siddhartha Systematic Investment Scheme",
          Is_SIP: true
        }
      ],
      statement: [],
      navData:
        options.navValue === undefined
          ? {}
          : {
              IsSucess: true,
              ResponseData: [
                { Scheme_code: "001", nav_date: "2024-03-20", nav_value: options.navValue }
              ]
            },
      overallNav: []
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

describe("SSIS review round 2 — holder binding bypasses (Postgres)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("honors an explicit reset when the first BO is set over snapshot-imported data", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    // The advertised snapshot-first workflow: import before any BO exists.
    await importSsisSnapshot(db(), actor, buildSsisPayload(), "import");
    let insight = await getSsisInsight(db(), actor);
    expect(insight.hasBoAccount).toBe(false);
    expect(insight.purchases).toHaveLength(3);
    expect(insight.holderName).toBe("Test Holder");

    // The admin explicitly confirms the data belongs to a different holder:
    // the reset must actually happen, not be silently ignored just because
    // no BO was configured before.
    const result = await setSsisBoAccountNo(db(), actor, BO_B, { resetExistingData: true });
    expect(result.dataReset).toBe(true);
    insight = await getSsisInsight(db(), actor);
    expect(insight.boAccountMasked).toBe("••••4444");
    expect(insight.purchases).toHaveLength(0);
    expect(insight.statement).toHaveLength(0);
    expect(insight.holderName).toBeNull();
    expect(insight.lastSource).toBeNull();
    const [state] = await db().select().from(ssisInsightState);
    expect(state!.boAccountNo).toBe(BO_B);
    const configureAudits = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ssis.bo_account_configured"));
    expect(JSON.stringify(configureAudits)).toContain('"dataReset":true');
  });

  it("binds the first BO to imported data when no reset is requested", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await importSsisSnapshot(db(), actor, buildSsisPayload(), "import");
    const result = await setSsisBoAccountNo(db(), actor, BO_A);
    expect(result.dataReset).toBe(false);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.boAccountMasked).toBe("••••2222");
    expect(insight.purchases).toHaveLength(3);
    expect(insight.statement).toHaveLength(2);
    expect(insight.holderName).toBe("Test Holder");
    const [state] = await db().select().from(ssisInsightState);
    expect(state!.boAccountNo).toBe(BO_A);
  });

  it("rejects a statement-only snapshot that names a different holder", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await importSsisSnapshot(db(), actor, buildSsisPayload(), "import");
    // Identity lives only in the statement dataset here: unitPurchase is
    // empty, so a purchases-only name check sees no identity at all.
    await expect(
      importSsisSnapshot(db(), actor, statementOnlyPayload("Other Person", "T9"), "import")
    ).rejects.toThrow(/different holder/);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(3);
    expect(insight.statement).toHaveLength(2);
    expect(insight.holderName).toBe("Test Holder");
    const importAudits = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ssis.imported"));
    expect(importAudits).toHaveLength(1);
  });

  it("derives holder identity from the statement dataset when purchases carry none", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const counts = await importSsisSnapshot(
      db(),
      actor,
      statementOnlyPayload("Statement Holder", "T1"),
      "import"
    );
    expect(counts.statement).toBe(1);
    let insight = await getSsisInsight(db(), actor);
    expect(insight.holderName).toBe("Statement Holder");
    // Purchases naming that same holder now import; another holder's do not.
    const ok = await importSsisSnapshot(
      db(),
      actor,
      holderPayload("Statement", "Holder", 8301),
      "import"
    );
    expect(ok.purchases).toBe(1);
    await expect(
      importSsisSnapshot(db(), actor, holderPayload("Other", "Person", 8302), "import")
    ).rejects.toThrow(/different holder/);
    insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(1);
  });

  it("rejects an anonymous snapshot once the insight holds holder data", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await importSsisSnapshot(db(), actor, buildSsisPayload(), "import");
    await expect(importSsisSnapshot(db(), actor, anonymousPayload(8201), "import")).rejects.toThrow(
      /does not identify/
    );
    const insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(3);
    expect(insight.holderName).toBe("Test Holder");
    const importAudits = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ssis.imported"));
    expect(importAudits).toHaveLength(1);
  });

  it("still imports an anonymous snapshot into an empty insight", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const counts = await importSsisSnapshot(db(), actor, anonymousPayload(8201), "import");
    expect(counts.purchases).toBe(1);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(1);
    expect(insight.holderName).toBeNull();
  });

  it("rejects a snapshot whose own datasets name two different holders", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const payload = statementOnlyPayload("Other Person", "T1") as [
      { unitPurchase: unknown[]; statement: unknown[] }
    ];
    payload[0].unitPurchase = [
      {
        REQUEST_NO: 8401,
        FName: "Test",
        LName: "Holder",
        APPLY_DT: "2024-01-15",
        APPLY_UNIT: "10",
        AMOUNT: "100.00",
        APPSTATUS: "VERIFIED"
      }
    ];
    await expect(importSsisSnapshot(db(), actor, payload, "import")).rejects.toThrow(
      /more than one holder/
    );
    expect(await db().select().from(ssisPurchases)).toHaveLength(0);
    expect(await db().select().from(ssisStatementEntries)).toHaveLength(0);
    expect(await db().select().from(ssisInsightState)).toHaveLength(0);
  });
});

describe("SSIS review round 2 — effective-dataset bounds (Postgres)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("rejects a second fragment whose combined invested total cannot be represented", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    // Each fragment is individually safe (5e15 minor units); together they
    // total 1e16, past exact representation.
    const first = await importSsisSnapshot(
      db(),
      actor,
      bigPurchasePayload({ requestNo: 1, amount: "50000000000000.00", units: "10" }),
      "import"
    );
    expect(first.purchases).toBe(1);
    await expect(
      importSsisSnapshot(
        db(),
        actor,
        bigPurchasePayload({ requestNo: 2, amount: "50000000000000.00", units: "10" }),
        "import"
      )
    ).rejects.toThrow(/too large/);
    // The rejected fragment rolled back: only the first purchase persists.
    const rows = await db().select().from(ssisPurchases);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestNo).toBe("1");
    const insight = await getSsisInsight(db(), actor);
    expect(insight.summary.totalInvestedMinor).toBe(5000000000000000);
    const importAudits = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ssis.imported"));
    expect(importAudits).toHaveLength(1);
  });

  it("rejects a second fragment whose combined unit total cannot be represented", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    const first = await importSsisSnapshot(
      db(),
      actor,
      bigPurchasePayload({ requestNo: 1, amount: "100.00", units: "500000000000" }),
      "import"
    );
    expect(first.purchases).toBe(1);
    await expect(
      importSsisSnapshot(
        db(),
        actor,
        bigPurchasePayload({ requestNo: 2, amount: "100.00", units: "500000000000" }),
        "import"
      )
    ).rejects.toThrow(/too large/);
    expect(await db().select().from(ssisPurchases)).toHaveLength(1);
  });

  it("rejects an import whose new NAV makes the stored position's value unrepresentable", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    // A large position with no NAV anywhere yet: nothing to value against.
    await importSsisSnapshot(
      db(),
      actor,
      bigPurchasePayload({ requestNo: 1, amount: "100.00", units: "500000000000" }),
      "import"
    );
    // A small second purchase carrying a huge current NAV. The incoming
    // fragment alone values safely; applied to the stored position it
    // overflows, so the whole import — purchase included — rolls back.
    await expect(
      importSsisSnapshot(
        db(),
        actor,
        bigPurchasePayload({
          requestNo: 2,
          amount: "10.00",
          units: "1",
          navValue: "1000000.00"
        }),
        "import"
      )
    ).rejects.toThrow(/too large/);
    expect(await db().select().from(ssisPurchases)).toHaveLength(1);
    const [state] = await db().select().from(ssisInsightState);
    expect(state!.latestNavMinor).toBeNull();
    const importAudits = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ssis.imported"));
    expect(importAudits).toHaveLength(1);
  });

  it("rejects a NAV-only refresh that would overflow the stored position, leaving state untouched", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, BO_A);
    // 5e11 units valued at NAV 1.00: value 5e13 minor units, safely inside.
    await importSsisSnapshot(
      db(),
      actor,
      bigPurchasePayload({
        requestNo: 1,
        amount: "100.00",
        units: "500000000000",
        navValue: "1.00"
      }),
      "import"
    );
    const [before] = await db().select().from(ssisInsightState);
    expect(before!.latestNavMinor).toBe(100);

    // Partial refresh: purchases, statement and history all fail upstream;
    // only the current NAV arrives, at 1,000,000.00. Applied to the stored
    // position the value cannot be represented, so the commit rolls back.
    const navOnlyFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("GetNAV")) {
        return jsonResponse({
          ResponseData: [{ Scheme_code: "001", nav_date: "2024-03-21", nav_value: "1000000.00" }]
        });
      }
      return jsonResponse(
        url.includes("admin-ajax.php") ? { success: false, data: [] } : APP_ERROR_BODY
      );
    };
    await expect(refreshSsis(db(), actor, navOnlyFetch)).rejects.toThrow(/too large/);
    const [after] = await db().select().from(ssisInsightState);
    expect(after!.latestNavMinor).toBe(100);
    expect(after!.lastSource).toBe("import");
    expect(await db().select().from(ssisPurchases)).toHaveLength(1);
    const refreshAudits = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ssis.refreshed"));
    expect(refreshAudits).toHaveLength(0);
  });
});

describe("SSIS effective bounds use the household date", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  it("rolls back a quote current locally but still future-dated in UTC", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T20:00:00Z"));
    try {
      const actor = actorOf(await makeUser({ timezone: "Asia/Kathmandu" }));
      await setSsisBoAccountNo(db(), actor, BO_A);
      await importSsisSnapshot(
        db(),
        actor,
        bigPurchasePayload({
          requestNo: 1,
          amount: "100.00",
          units: "500000000000",
          navValue: "1.00"
        }),
        "import"
      );
      const [before] = await db().select().from(ssisInsightState);
      const update = [
        {
          unitPurchase: [],
          statement: [],
          navData: {},
          overallNav: [{ eng_date: "2026-11-17", nep_date: "2083-08-01", nav: "1000000.00" }]
        }
      ];
      await expect(
        importSsisSnapshot(db(), actor, update, "refresh", {
          expectedConfig: { boAccountNo: BO_A, configGeneration: 0 }
        })
      ).rejects.toThrow(/too large/);
      const [after] = await db().select().from(ssisInsightState);
      expect(after).toEqual(before);
      expect((await getSsisInsight(db(), actor)).summary.currentValueMinor).toBe(50000000000000);
      expect(await db().select().from(ssisNavHistory)).toHaveLength(0);
      const audits = await db()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "ssis.refreshed"));
      expect(audits).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A statement-only snapshot carrying no holder identity anywhere. */
function anonymousStatementPayload(transNo: string): unknown {
  return [
    {
      unitPurchase: [],
      statement: [
        {
          scheme_code: "001",
          ccode: "1000",
          SIP_Reg_No: "SIP0001",
          trans_no: transNo,
          installmentDate: "2024-01-15",
          dueDate: null,
          actionDate: "2024-01-16",
          Amount_cr: "100.00",
          Amount_dr: "-",
          unit: "10",
          appnav: "10.00",
          payment: "E-Sewa",
          otherCharges: "0",
          sebon_fee: "0"
        }
      ],
      navData: {},
      overallNav: []
    }
  ];
}

describe("SSIS review round 3 — anonymous seed must not silently acquire a holder (Postgres)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("rejects a named purchase import over an anonymously seeded insight", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    // Seed with a snapshot that identifies no holder in any dataset.
    await importSsisSnapshot(db(), actor, anonymousPayload(9001), "import");
    let insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(1);
    expect(insight.holderName).toBeNull();

    // A later import naming a holder must not silently merge and bind the
    // anonymous rows to that holder.
    await expect(
      importSsisSnapshot(db(), actor, holderPayload("Test", "Holder", 9002), "import")
    ).rejects.toThrow(/silently bound/);
    insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(1);
    expect(insight.holderName).toBeNull();
    const importAudits = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "ssis.imported"));
    expect(importAudits).toHaveLength(1);
  });

  it("rejects a named purchase import over an anonymous statement-only seed", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await importSsisSnapshot(db(), actor, anonymousStatementPayload("TA1"), "import");
    let insight = await getSsisInsight(db(), actor);
    expect(insight.statement).toHaveLength(1);
    expect(insight.holderName).toBeNull();

    await expect(
      importSsisSnapshot(db(), actor, holderPayload("Test", "Holder", 9003), "import")
    ).rejects.toThrow(/silently bound/);
    insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(0);
    expect(insight.statement).toHaveLength(1);
    expect(insight.holderName).toBeNull();
  });

  it("rejects a named statement import over an anonymous purchase seed", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await importSsisSnapshot(db(), actor, anonymousPayload(9004), "import");
    await expect(
      importSsisSnapshot(db(), actor, statementOnlyPayload("Test Holder", "TA2"), "import")
    ).rejects.toThrow(/silently bound/);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(1);
    expect(insight.statement).toHaveLength(0);
    expect(insight.holderName).toBeNull();
  });

  it("keeps anonymous data unidentified after a plain BO binding, and still rejects a named import", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await importSsisSnapshot(db(), actor, anonymousPayload(9005), "import");
    // Setting the BO number without a reset binds the NUMBER to the
    // imported data; it must not launder the anonymous rows into
    // identified data — the BO number carries no holder name.
    const result = await setSsisBoAccountNo(db(), actor, BO_A);
    expect(result.dataReset).toBe(false);
    let insight = await getSsisInsight(db(), actor);
    expect(insight.hasBoAccount).toBe(true);
    expect(insight.purchases).toHaveLength(1);
    expect(insight.holderName).toBeNull();
    // A named file import is still rejected afterwards.
    await expect(
      importSsisSnapshot(db(), actor, holderPayload("Test", "Holder", 9006), "import")
    ).rejects.toThrow(/silently bound/);
    insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(1);
    expect(insight.holderName).toBeNull();
  });

  it("allows a named import after a confirmed BO reset clears the anonymous data", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await importSsisSnapshot(db(), actor, anonymousPayload(9007), "import");
    const result = await setSsisBoAccountNo(db(), actor, BO_A, { resetExistingData: true });
    expect(result.dataReset).toBe(true);
    let insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(0);
    expect(insight.holderName).toBeNull();
    // The insight is empty again, so a named snapshot seeds and binds it.
    const counts = await importSsisSnapshot(
      db(),
      actor,
      holderPayload("Test", "Holder", 9008),
      "import"
    );
    expect(counts.purchases).toBe(1);
    insight = await getSsisInsight(db(), actor);
    expect(insight.purchases).toHaveLength(1);
    expect(insight.holderName).toBe("Test Holder");
  });

  it("still lets a live refresh bind the BO-configured holder over anonymous data", async () => {
    const user = await makeUser();
    const actor = actorOf(user);
    await importSsisSnapshot(db(), actor, anonymousPayload(9009), "import");
    await setSsisBoAccountNo(db(), actor, BO_A);
    // Refresh semantics are unchanged: the refresh is bound to the
    // configured BO account by the generation guard, so the identity it
    // carries is the configured holder's — binding through it is the
    // sanctioned path, unlike an arbitrary file import.
    const result = await refreshSsis(db(), actor, stubUpstream());
    expect(result.purchases).toBe(3);
    const insight = await getSsisInsight(db(), actor);
    expect(insight.holderName).toBe("Test Holder");
    // The anonymous row remains alongside the refreshed rows.
    expect(insight.purchases.length).toBeGreaterThanOrEqual(3);
  });
});
