import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { actorOf, db, makeUser, truncateAll, type TestUser } from "../helpers";
import {
  auditEvents,
  ssisInsightState,
  ssisNavHistory,
  ssisPurchases,
  ssisStatementEntries
} from "@/server/db/schema";
import type { McpConfig } from "@/lib/env";
import { randomToken } from "@/lib/crypto";
import {
  approveAuthorizationRequest,
  consumeAuthorizationRequest,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  listConnectionsForUser,
  registerOAuthClient,
  resolveOAuthClient,
  revokeGrant,
  setGrantSsisAccess,
  validateAuthorizeRequest,
  type AuthorizeRequest,
  type OAuthGrantRow,
  type TokenSuccess
} from "@/server/domain/oauth";
import {
  getSsisInsight,
  importSsisSnapshot,
  refreshSsis,
  setSsisBoAccountNo
} from "@/server/domain/ssis";
import { POST as mcpPost } from "@/app/mcp/route";
import { buildSsisPayload, SSIS_PII } from "../fixtures/ssis-snapshot";

// SSIS MCP tools: read-only access to the household SSIS insight behind
// an explicit per-connection permission (oauth_grants.ssis_access).
// finance:read alone must never unlock it. Same harness as
// mcp-tools.test.ts (service-level consent flow + real /mcp route
// calls); SSIS data is seeded from the synthetic fixture only.

const CONFIG: McpConfig = {
  resourceUrl: "https://meridian.test/mcp",
  issuerUrl: "https://meridian.test",
  cimdAllowlist: [],
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 30 * 24 * 3600,
  authorizationCodeTtlSeconds: 300,
  grantTtlSeconds: 90 * 24 * 3600
};

const LOOPBACK = "http://127.0.0.1:8910/callback";
const ALL_READ_SCOPES = [
  "finance:read",
  "transactions:read",
  "transactions:notes",
  "offline_access"
];
const SSIS_TOOLS = [
  "get_ssis_summary",
  "list_ssis_purchases",
  "list_ssis_statement",
  "get_ssis_nav_history"
] as const;

/** A synthetic BO number the user "entered" — must never reach a tool. */
const ENTERED_BO = "1301000011112222";

const ENV_KEYS = ["MCP_ENABLED", "MCP_RESOURCE_URL", "MCP_ISSUER_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.MCP_ENABLED = "true";
  process.env.MCP_RESOURCE_URL = "https://meridian.test/mcp";
  process.env.MCP_ISSUER_URL = "https://meridian.test";
  await truncateAll();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function pkce() {
  const verifier = randomToken(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

type Flow = { grant: OAuthGrantRow; tokens: TokenSuccess };

async function connectFlow(
  user: TestUser,
  opts: { scopes?: string[]; ssisAccess?: boolean } = {}
): Promise<Flow> {
  const exec = db();
  const { client: dcr } = await registerOAuthClient(exec, {
    clientName: "SSIS Client",
    redirectUris: [LOOPBACK]
  });
  const client = (await resolveOAuthClient(exec, dcr.id))!;
  const { verifier, challenge } = pkce();
  const request: AuthorizeRequest = await validateAuthorizeRequest(
    exec,
    {
      clientId: client.clientId,
      redirectUri: LOOPBACK,
      responseType: "code",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: (opts.scopes ?? ALL_READ_SCOPES).join(" "),
      resource: CONFIG.resourceUrl,
      state: "state-1"
    },
    CONFIG
  );
  const actor = actorOf(user);
  const { record, csrfToken } = await createAuthorizationRequest(exec, { actor, request });
  const consumed = await consumeAuthorizationRequest(exec, {
    requestId: record.id,
    actor,
    csrfToken
  });
  const { grant, code } = await approveAuthorizationRequest(
    exec,
    consumed,
    CONFIG,
    opts.ssisAccess ? { actor, ssisAccess: true } : undefined
  );
  const tokens = await exchangeAuthorizationCode(
    exec,
    { code, redirectUri: LOOPBACK, codeVerifier: verifier, resource: CONFIG.resourceUrl },
    client,
    CONFIG
  );
  return { grant, tokens };
}

async function rpc(token: string | null, body: unknown) {
  const res = await mcpPost(
    new Request("https://meridian.test/mcp", {
      method: "POST",
      headers: {
        host: "meridian.test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    })
  );
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          parsed = JSON.parse(line.slice(5)) as Record<string, unknown>;
        } catch {
          /* keep scanning */
        }
      }
    }
  } else if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, body: parsed };
}

type ToolResult = {
  isError?: boolean;
  content?: { text: string }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structuredContent?: any;
};

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(token, {
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: { name, arguments: args }
  });
  const result = (res.body as { result?: ToolResult } | null)?.result;
  return { status: res.status, result, data: result?.structuredContent };
}

async function seedSsis(user: TestUser) {
  await importSsisSnapshot(db(), actorOf(user), buildSsisPayload(), "import");
}

describe("SSIS permission gate", () => {
  it("stores ssisAccess=false by default and true only on explicit consent", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const plain = await connectFlow(user);
    expect(plain.grant.ssisAccess).toBe(false);
    const optedIn = await connectFlow(user, { ssisAccess: true });
    expect(optedIn.grant.ssisAccess).toBe(true);
  });

  it("denies every SSIS tool when the grant lacks the permission, even with finance:read", async () => {
    const user = await makeUser({ timezone: "UTC" });
    await seedSsis(user);
    const flow = await connectFlow(user);
    for (const tool of SSIS_TOOLS) {
      const res = await callTool(flow.tokens.accessToken, tool);
      expect(res.result?.isError, tool).toBe(true);
      expect(res.result?.content?.[0]?.text ?? "", tool).toContain("SSIS");
      expect(res.data, tool).toBeUndefined();
    }
  });

  it("still requires finance:read: a transactions-only grant with the SSIS flag is denied", async () => {
    const user = await makeUser({ timezone: "UTC" });
    await seedSsis(user);
    const flow = await connectFlow(user, {
      scopes: ["transactions:read", "offline_access"],
      ssisAccess: true
    });
    const res = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    expect(res.result?.isError).toBe(true);
  });

  it("owner toggle takes effect immediately on the same token; non-owners cannot toggle", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const stranger = await makeUser({ timezone: "UTC" });
    await seedSsis(user);
    const flow = await connectFlow(user);

    const denied = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    expect(denied.result?.isError).toBe(true);

    // A non-owner toggle attempt is a no-op.
    expect(await setGrantSsisAccess(db(), flow.grant.id, stranger.userId, true)).toBe(false);
    const stillDenied = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    expect(stillDenied.result?.isError).toBe(true);

    // Owner enables: the very next call with the SAME token succeeds.
    expect(await setGrantSsisAccess(db(), flow.grant.id, user.userId, true)).toBe(true);
    const allowed = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    expect(allowed.result?.isError).not.toBe(true);
    expect(allowed.data?.ssis?.hasData).toBe(true);

    // Owner disables: denied again immediately.
    expect(await setGrantSsisAccess(db(), flow.grant.id, user.userId, false)).toBe(true);
    const deniedAgain = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    expect(deniedAgain.result?.isError).toBe(true);

    // The toggle shows up in the connection's settings history.
    const connections = await listConnectionsForUser(db(), user.userId);
    const mine = connections.find((c) => c.grant.id === flow.grant.id);
    expect(mine?.history.some((h) => h.action === "oauth_grant.ssis_access_changed")).toBe(true);
  });

  it("a revoked connection is denied", async () => {
    const user = await makeUser({ timezone: "UTC" });
    await seedSsis(user);
    const flow = await connectFlow(user, { ssisAccess: true });
    const ok = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    expect(ok.result?.isError).not.toBe(true);
    await revokeGrant(db(), flow.grant.id, user.userId);
    const res = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    expect(res.status).toBe(401);
    expect(res.data).toBeUndefined();
  });
});

describe("SSIS tool payloads", () => {
  it("summary, purchases, statement and NAV match the domain read model", async () => {
    const user = await makeUser({ timezone: "UTC" });
    await seedSsis(user);
    const flow = await connectFlow(user, { ssisAccess: true });
    const insight = await getSsisInsight(db(), actorOf(user));

    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    expect(summary.result?.isError).not.toBe(true);
    const ssis = summary.data.ssis;
    expect(ssis.hasData).toBe(true);
    expect(ssis.currency).toBe("NPR");
    expect(ssis.counts).toEqual({ purchases: 3, statementEntries: 2, navPoints: 4 });
    expect(ssis.totals.totalUnits).toBe(insight.summary.totalUnits);
    expect(ssis.totals.totalInvested).toEqual({
      amountMinor: String(insight.summary.totalInvestedMinor),
      currency: "NPR",
      currencyExponent: 2
    });
    expect(ssis.totals.totalInvested.amountMinor).toBe("177260");
    // Latest NAV not in the future (2024-03-31, 11.00) — the 2999 point
    // in the fixture must never become "current".
    expect(ssis.currentNav).toEqual({
      amountMinor: "1100",
      currency: "NPR",
      currencyExponent: 2,
      date: "2024-03-31"
    });
    expect(ssis.totals.currentValue.amountMinor).toBe("193325");
    expect(ssis.totals.profit.amountMinor).toBe("16065");
    expect(ssis.dataAsOf).toBe(insight.lastFetchedAt);
    expect(ssis.limitations.join(" ")).toContain("not part of account balances");

    const purchases = await callTool(flow.tokens.accessToken, "list_ssis_purchases");
    expect(purchases.data.purchases).toHaveLength(3);
    expect(purchases.data.purchases[0]).toMatchObject({
      requestNo: "1001",
      applyDate: "2024-01-15",
      units: "100.25",
      status: "VERIFIED",
      isSip: true
    });
    expect(purchases.data.purchases[0].amount).toEqual({
      amountMinor: "100250",
      currency: "NPR",
      currencyExponent: 2
    });
    expect(purchases.data.page).toMatchObject({ totalMatching: 3, returned: 3, hasMore: false });

    const statement = await callTool(flow.tokens.accessToken, "list_ssis_statement");
    expect(statement.data.statement).toHaveLength(2);
    expect(statement.data.statement[0]).toMatchObject({
      transNo: "T1",
      installmentDate: "2024-01-15",
      payment: "E-Sewa"
    });
    expect(statement.data.statement[0].amountCr.amountMinor).toBe("100250");
    // The SIP registration number is a holder identifier: not exposed.
    expect(JSON.stringify(statement.data)).not.toContain("SIP0001");
    expect(JSON.stringify(statement.data)).not.toContain("sipRegNo");

    const nav = await callTool(flow.tokens.accessToken, "get_ssis_nav_history");
    expect(nav.data.points).toHaveLength(4);
    expect(nav.data.points[0]).toMatchObject({ engDate: "2024-01-31", nepDate: "2080-10-17" });
    expect(nav.data.points[0].nav.amountMinor).toBe("1010");
    expect(nav.data.currentNav.amountMinor).toBe("1100");
    expect(nav.data.page.totalMatching).toBe(4);
  });

  it("household isolation: another household's permitted connection sees only its own (empty) SSIS", async () => {
    const owner = await makeUser({ timezone: "UTC" });
    await seedSsis(owner);
    const other = await makeUser({ timezone: "UTC" });
    const otherFlow = await connectFlow(other, { ssisAccess: true });

    const summary = await callTool(otherFlow.tokens.accessToken, "get_ssis_summary");
    expect(summary.result?.isError).not.toBe(true);
    expect(summary.data.ssis.hasData).toBe(false);
    expect(summary.data.ssis.counts).toEqual({ purchases: 0, statementEntries: 0, navPoints: 0 });
    const purchases = await callTool(otherFlow.tokens.accessToken, "list_ssis_purchases");
    expect(purchases.data.purchases).toEqual([]);
    expect(purchases.data.page.totalMatching).toBe(0);
  });

  it("pagination and date filters are bounded", async () => {
    const user = await makeUser({ timezone: "UTC" });
    await seedSsis(user);
    for (const [requestNo, applyDate] of [
      ["2001", "2024-04-15"],
      ["2002", "2024-05-15"],
      ["2003", "2024-06-15"]
    ] as const) {
      await db().insert(ssisPurchases).values({
        familyId: user.familyId,
        requestNo,
        applyDate,
        units: "10",
        amountMinor: 10000,
        status: "VERIFIED",
        purchaseNavMinor: 1000,
        navDate: applyDate,
        schemeName: null,
        isSip: true
      });
    }
    const flow = await connectFlow(user, { ssisAccess: true });

    const page1 = await callTool(flow.tokens.accessToken, "list_ssis_purchases", { limit: 2 });
    expect(page1.data.purchases.map((p: { applyDate: string }) => p.applyDate)).toEqual([
      "2024-01-15",
      "2024-02-15"
    ]);
    expect(page1.data.page).toMatchObject({ totalMatching: 6, returned: 2, hasMore: true });
    const page2 = await callTool(flow.tokens.accessToken, "list_ssis_purchases", {
      limit: 2,
      offset: 2
    });
    expect(page2.data.purchases.map((p: { applyDate: string }) => p.applyDate)).toEqual([
      "2024-03-15",
      "2024-04-15"
    ]);

    const filtered = await callTool(flow.tokens.accessToken, "list_ssis_purchases", {
      from: "2024-03-01",
      to: "2024-05-31"
    });
    expect(filtered.data.page.totalMatching).toBe(3);
    expect(filtered.data.period).toEqual({ from: "2024-03-01", to: "2024-05-31" });

    const tooBig = await callTool(flow.tokens.accessToken, "list_ssis_purchases", { limit: 101 });
    expect(tooBig.result?.isError).toBe(true);
    const inverted = await callTool(flow.tokens.accessToken, "list_ssis_purchases", {
      from: "2024-06-01",
      to: "2024-01-01"
    });
    expect(inverted.result?.isError).toBe(true);
  });

  it("never returns BO numbers, holder identifiers or payload PII — in outputs or audit metadata", async () => {
    const user = await makeUser({ timezone: "UTC" });
    await seedSsis(user);
    // The user-entered BO lives in state; it must still never leak.
    await setSsisBoAccountNo(db(), actorOf(user), ENTERED_BO);
    const flow = await connectFlow(user, { ssisAccess: true });

    let everything = "";
    for (const tool of SSIS_TOOLS) {
      const res = await callTool(flow.tokens.accessToken, tool);
      expect(res.result?.isError, tool).not.toBe(true);
      everything += JSON.stringify(res.result);
    }
    for (const secret of [...Object.values(SSIS_PII), ENTERED_BO, "Test Holder", "SIP0001"]) {
      expect(everything).not.toContain(secret);
    }

    const audits = await db()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "mcp.tool_called"));
    expect(audits.length).toBeGreaterThanOrEqual(4);
    for (const audit of audits) {
      const metadata = JSON.stringify(audit.metadata);
      for (const secret of [...Object.values(SSIS_PII), ENTERED_BO, "Test Holder"]) {
        expect(metadata).not.toContain(secret);
      }
      // Metadata is the tool name only — no financial results.
      expect(Object.keys((audit.metadata ?? {}) as Record<string, unknown>)).toEqual(["tool"]);
    }
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

type CoverageStubOptions = {
  failPurchases?: boolean;
  failStatement?: boolean;
  emptyHolder?: boolean;
  /**
   * Return the fixture's rows exactly as exported, including its
   * malformed ones (2 purchases, 1 statement row). By default the stub
   * returns only the well-formed rows, so a "complete" refresh really
   * is complete; the malformed variant exercises extraction coverage.
   */
  includeMalformed?: boolean;
  /** Purchases response is nonempty but EVERY row is malformed. */
  allInvalidPurchases?: boolean;
};

function isWellFormedPurchase(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return r.REQUEST_NO != null && r.APPLY_UNIT !== "not-a-number";
}

function isWellFormedStatement(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.trans_no === "string" && r.trans_no !== "";
}

/** Upstream stub in the shape of tests/integration/ssis.test.ts, with
 * per-dataset failure switches for the coverage regressions. */
function stubCoverageUpstream(options: CoverageStubOptions = {}): typeof fetch {
  return async (input) => {
    const url = String(input);
    const payload = buildSsisPayload() as [{ unitPurchase: unknown[]; statement: unknown[] }];
    if (url.includes("PurchaseRequesthandler")) {
      if (options.failPurchases) return jsonResponse({ message: "boom" }, 500);
      if (options.emptyHolder) return jsonResponse({ ResponseData: [] });
      if (options.allInvalidPurchases) {
        return jsonResponse({
          ResponseData: payload[0].unitPurchase.filter((r) => !isWellFormedPurchase(r))
        });
      }
      return jsonResponse({
        ResponseData: options.includeMalformed
          ? payload[0].unitPurchase
          : payload[0].unitPurchase.filter(isWellFormedPurchase)
      });
    }
    if (url.includes("HolderStatement")) {
      if (options.failStatement) return jsonResponse({ message: "boom" }, 500);
      return jsonResponse({
        ResponseData: options.emptyHolder
          ? []
          : options.includeMalformed
            ? payload[0].statement
            : payload[0].statement.filter(isWellFormedStatement)
      });
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

/** The shared fixture with its malformed rows removed — a snapshot
 * that extraction can account for completely. */
function buildCleanSsisPayload(): unknown {
  const payload = buildSsisPayload() as [{ unitPurchase: unknown[]; statement: unknown[] }];
  return [
    {
      ...payload[0],
      unitPurchase: payload[0].unitPurchase.filter(isWellFormedPurchase),
      statement: payload[0].statement.filter(isWellFormedStatement)
    }
  ];
}

describe("SSIS coverage reporting", () => {
  it("snapshot import with malformed rows: skipped rows make coverage partial, never complete", async () => {
    const user = await makeUser({ timezone: "UTC" });
    // The shared fixture carries 2 malformed purchase rows and 1
    // malformed statement row (skipped=3): extraction drops them, so
    // the import — however clean its envelope — did NOT fully account
    // for either holder dataset.
    await seedSsis(user);
    const flow = await connectFlow(user, { ssisAccess: true });

    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    const ssis = summary.data.ssis;
    expect(ssis.coverage.purchases.status).toBe("partial");
    expect(ssis.coverage.statement.status).toBe("partial");
    expect(ssis.coverage.nav.status).toBe("ok");
    // No complete fetch has ever happened for the holder datasets.
    expect(ssis.coverage.purchases.fetchedAt).toBeNull();
    expect(ssis.totals.complete).toBe(false);
    // The valid rows still drive the totals — labelled as subtotals.
    expect(ssis.totals.totalInvested.amountMinor).toBe("177260");
    expect(ssis.limitations.join(" ")).toMatch(/Purchase data may be incomplete/);
    expect(ssis.limitations.join(" ")).toMatch(/observed subtotals/);
  });

  it("clean snapshot import establishes full coverage and complete totals", async () => {
    const user = await makeUser({ timezone: "UTC" });
    await importSsisSnapshot(db(), actorOf(user), buildCleanSsisPayload(), "import");
    const flow = await connectFlow(user, { ssisAccess: true });

    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    const ssis = summary.data.ssis;
    expect(ssis.coverage.purchases.status).toBe("ok");
    expect(ssis.coverage.statement.status).toBe("ok");
    expect(ssis.coverage.nav.status).toBe("ok");
    expect(ssis.coverage.purchases.fetchedAt).not.toBeNull();
    expect(ssis.totals.complete).toBe(true);
    expect(ssis.limitations.join(" ")).not.toMatch(/incomplete|coverage is unknown/);
  });

  it("NAV-only refresh: failed holder datasets are not presented as a known zero position", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, ENTERED_BO);
    const result = await refreshSsis(
      db(),
      actor,
      stubCoverageUpstream({ failPurchases: true, failStatement: true })
    );
    expect(result.warnings).toHaveLength(2);

    const flow = await connectFlow(user, { ssisAccess: true });
    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    const ssis = summary.data.ssis;
    // NAV arrived, so the insight has data and a fresh overall dataAsOf…
    expect(ssis.hasData).toBe(true);
    expect(ssis.dataAsOf).not.toBeNull();
    // …but purchase coverage is failed, never established, and the zero
    // totals are flagged as observed subtotals rather than a position.
    expect(ssis.coverage.purchases).toEqual({ status: "failed", fetchedAt: null });
    expect(ssis.coverage.statement.status).toBe("failed");
    expect(ssis.coverage.nav.status).toBe("ok");
    expect(ssis.coverage.nav.fetchedAt).not.toBeNull();
    expect(ssis.totals.complete).toBe(false);
    expect(ssis.totals.totalInvested.amountMinor).toBe("0");
    expect(ssis.totals.totalUnits).toBe("0");
    const limitations = ssis.limitations.join(" ");
    expect(limitations).toMatch(/Purchase data may be incomplete/);
    expect(limitations).toMatch(/observed subtotals/);
    expect(limitations).toMatch(/does not imply every dataset was refreshed/);

    const purchases = await callTool(flow.tokens.accessToken, "list_ssis_purchases");
    expect(purchases.data.coverage.purchases.status).toBe("failed");
    expect(purchases.data.dataAsOf).toBeNull();
    expect(purchases.data.page.totalMatching).toBe(0);
    expect(purchases.data.limitations.join(" ")).toMatch(/only the purchase rows currently stored/);
    expect(purchases.data.limitations.join(" ")).toMatch(/could not retrieve/);

    const statement = await callTool(flow.tokens.accessToken, "list_ssis_statement");
    expect(statement.data.coverage.statement.status).toBe("failed");
    expect(statement.data.limitations.join(" ")).toMatch(/could not retrieve/);

    const nav = await callTool(flow.tokens.accessToken, "get_ssis_nav_history");
    expect(nav.data.coverage.nav.status).toBe("ok");
    expect(nav.data.limitations).toEqual([]);
  });

  it("partial refresh over older rows: holder data stays visibly stale, success timestamps unmoved", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, ENTERED_BO);
    const first = await refreshSsis(db(), actor, stubCoverageUpstream());
    expect(first.warnings).toEqual([]);
    const [afterFirst] = await db()
      .select()
      .from(ssisInsightState)
      .where(eq(ssisInsightState.familyId, user.familyId));
    expect(afterFirst!.purchasesCoverage).toBe("ok");
    expect(afterFirst!.purchasesFetchedAt).not.toBeNull();

    const second = await refreshSsis(
      db(),
      actor,
      stubCoverageUpstream({ failPurchases: true, failStatement: true })
    );
    expect(second.warnings).toHaveLength(2);
    const [afterSecond] = await db()
      .select()
      .from(ssisInsightState)
      .where(eq(ssisInsightState.familyId, user.familyId));
    expect(afterSecond!.purchasesCoverage).toBe("failed");
    expect(afterSecond!.statementCoverage).toBe("failed");
    // The failure must not move the last-success timestamps.
    expect(afterSecond!.purchasesFetchedAt).toEqual(afterFirst!.purchasesFetchedAt);
    expect(afterSecond!.statementFetchedAt).toEqual(afterFirst!.statementFetchedAt);
    expect(afterSecond!.navCoverage).toBe("ok");

    const flow = await connectFlow(user, { ssisAccess: true });
    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    const ssis = summary.data.ssis;
    // The stored rows still drive the totals — labelled as subtotals.
    expect(ssis.totals.totalInvested.amountMinor).toBe("177260");
    expect(ssis.totals.complete).toBe(false);
    expect(ssis.coverage.purchases.status).toBe("failed");
    expect(ssis.coverage.purchases.fetchedAt).toBe(
      new Date(afterFirst!.purchasesFetchedAt!).toISOString()
    );
    expect(ssis.coverage.nav.status).toBe("ok");
    expect(ssis.limitations.join(" ")).toMatch(/last complete fetch/);
  });

  it("complete refresh: full coverage, totals complete, no incompleteness caveats", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, ENTERED_BO);
    const result = await refreshSsis(db(), actor, stubCoverageUpstream());
    expect(result.warnings).toEqual([]);

    const flow = await connectFlow(user, { ssisAccess: true });
    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    const ssis = summary.data.ssis;
    expect(ssis.coverage.purchases.status).toBe("ok");
    expect(ssis.coverage.statement.status).toBe("ok");
    expect(ssis.coverage.nav.status).toBe("ok");
    expect(ssis.totals.complete).toBe(true);
    expect(ssis.totals.totalInvested.amountMinor).toBe("177260");
    expect(ssis.limitations.join(" ")).not.toMatch(/incomplete|coverage is unknown/);

    const purchases = await callTool(flow.tokens.accessToken, "list_ssis_purchases");
    expect(purchases.data.coverage.purchases.status).toBe("ok");
    expect(purchases.data.dataAsOf).not.toBeNull();
    expect(purchases.data.limitations.join(" ")).not.toMatch(/incomplete|coverage is unknown/);
  });

  it("genuinely empty position: holder endpoints succeed with no rows — zero totals are complete", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, ENTERED_BO);
    const result = await refreshSsis(db(), actor, stubCoverageUpstream({ emptyHolder: true }));
    expect(result.warnings).toEqual([]);
    expect(result.purchases).toBe(0);
    expect(result.statement).toBe(0);

    const flow = await connectFlow(user, { ssisAccess: true });
    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    const ssis = summary.data.ssis;
    expect(ssis.coverage.purchases.status).toBe("ok");
    expect(ssis.coverage.statement.status).toBe("ok");
    expect(ssis.totals.complete).toBe(true);
    expect(ssis.totals.totalInvested.amountMinor).toBe("0");
    expect(ssis.totals.totalUnits).toBe("0");
    expect(ssis.limitations.join(" ")).not.toMatch(/incomplete|coverage is unknown/);
  });

  it("populated then successful-empty refresh: retained rows are reported partial with unmoved timestamps", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, ENTERED_BO);
    const first = await refreshSsis(db(), actor, stubCoverageUpstream());
    expect(first.warnings).toEqual([]);
    expect(first.purchases).toBe(3);
    expect(first.statement).toBe(2);
    const [afterFirst] = await db()
      .select()
      .from(ssisInsightState)
      .where(eq(ssisInsightState.familyId, user.familyId));
    expect(afterFirst!.purchasesCoverage).toBe("ok");
    expect(afterFirst!.statementCoverage).toBe("ok");

    // The holder endpoints now succeed with EMPTY datasets. The import
    // is upsert-only, so the previously stored rows are retained — they
    // must not be presented as refreshed or complete, and the
    // effective-data timestamps must stay at the first fetch.
    const second = await refreshSsis(db(), actor, stubCoverageUpstream({ emptyHolder: true }));
    expect(second.warnings).toEqual([]);
    expect(second.purchases).toBe(0);
    expect(second.statement).toBe(0);

    const storedPurchases = await db()
      .select()
      .from(ssisPurchases)
      .where(eq(ssisPurchases.familyId, user.familyId));
    const storedStatement = await db()
      .select()
      .from(ssisStatementEntries)
      .where(eq(ssisStatementEntries.familyId, user.familyId));
    expect(storedPurchases).toHaveLength(3);
    expect(storedStatement).toHaveLength(2);

    const [afterSecond] = await db()
      .select()
      .from(ssisInsightState)
      .where(eq(ssisInsightState.familyId, user.familyId));
    expect(afterSecond!.purchasesCoverage).toBe("partial");
    expect(afterSecond!.statementCoverage).toBe("partial");
    expect(afterSecond!.purchasesFetchedAt).toEqual(afterFirst!.purchasesFetchedAt);
    expect(afterSecond!.statementFetchedAt).toEqual(afterFirst!.statementFetchedAt);
    // NAV really was refreshed completely, so its coverage stays ok.
    expect(afterSecond!.navCoverage).toBe("ok");

    const flow = await connectFlow(user, { ssisAccess: true });
    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    const ssis = summary.data.ssis;
    // Retained rows still drive the totals — as flagged subtotals whose
    // effective date is the FIRST fetch, not the empty refresh.
    expect(ssis.totals.totalInvested.amountMinor).toBe("177260");
    expect(ssis.totals.complete).toBe(false);
    expect(ssis.coverage.purchases.status).toBe("partial");
    expect(ssis.coverage.statement.status).toBe("partial");
    expect(ssis.coverage.purchases.fetchedAt).toBe(
      new Date(afterFirst!.purchasesFetchedAt!).toISOString()
    );
    expect(ssis.coverage.statement.fetchedAt).toBe(
      new Date(afterFirst!.statementFetchedAt!).toISOString()
    );
    expect(ssis.limitations.join(" ")).toMatch(/Purchase data may be incomplete/);
    expect(ssis.limitations.join(" ")).toMatch(/Statement data may be incomplete/);
    expect(ssis.limitations.join(" ")).toMatch(/observed subtotals/);

    const purchases = await callTool(flow.tokens.accessToken, "list_ssis_purchases");
    expect(purchases.data.page.totalMatching).toBe(3);
    expect(purchases.data.dataAsOf).toBe(new Date(afterFirst!.purchasesFetchedAt!).toISOString());
    expect(purchases.data.limitations.join(" ")).toMatch(/may be incomplete/);
  });

  it("refresh with malformed rows mixed in: envelope success is partial coverage, not complete", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, ENTERED_BO);
    const result = await refreshSsis(db(), actor, stubCoverageUpstream({ includeMalformed: true }));
    // The fetch itself succeeded — no warnings — yet extraction dropped
    // rows from both holder datasets.
    expect(result.warnings).toEqual([]);
    expect(result.purchases).toBe(3);
    expect(result.statement).toBe(2);
    // Extraction skips 2 of the malformed rows here (the third — a
    // purchase with no REQUEST_NO — is already dropped by the fetcher's
    // key dedupe before the payload is built).
    expect(result.skipped).toBe(2);

    const [state] = await db()
      .select()
      .from(ssisInsightState)
      .where(eq(ssisInsightState.familyId, user.familyId));
    expect(state!.purchasesCoverage).toBe("partial");
    expect(state!.statementCoverage).toBe("partial");
    expect(state!.purchasesFetchedAt).toBeNull();
    expect(state!.navCoverage).toBe("ok");

    const flow = await connectFlow(user, { ssisAccess: true });
    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    const ssis = summary.data.ssis;
    expect(ssis.coverage.purchases.status).toBe("partial");
    expect(ssis.totals.complete).toBe(false);
    expect(ssis.totals.totalInvested.amountMinor).toBe("177260");
    expect(ssis.limitations.join(" ")).toMatch(/Purchase data may be incomplete/);
    expect(ssis.limitations.join(" ")).toMatch(/never been fetched completely/);
  });

  it("refresh whose purchase rows are ALL malformed: zero stored rows are partial, never a complete zero", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const actor = actorOf(user);
    await setSsisBoAccountNo(db(), actor, ENTERED_BO);
    const result = await refreshSsis(
      db(),
      actor,
      stubCoverageUpstream({ allInvalidPurchases: true })
    );
    expect(result.purchases).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);

    const [state] = await db()
      .select()
      .from(ssisInsightState)
      .where(eq(ssisInsightState.familyId, user.familyId));
    expect(state!.purchasesCoverage).toBe("partial");
    expect(state!.purchasesFetchedAt).toBeNull();
    // The clean datasets in the same refresh are unaffected.
    expect(state!.statementCoverage).toBe("ok");
    expect(state!.navCoverage).toBe("ok");

    const flow = await connectFlow(user, { ssisAccess: true });
    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    const ssis = summary.data.ssis;
    expect(ssis.coverage.purchases.status).toBe("partial");
    expect(ssis.totals.complete).toBe(false);
    expect(ssis.totals.totalInvested.amountMinor).toBe("0");
    expect(ssis.limitations.join(" ")).toMatch(/Purchase data may be incomplete/);
  });
});

describe("SSIS dataset shapes", () => {
  it("empty household: hasData=false, null NAV and value, empty lists", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const flow = await connectFlow(user, { ssisAccess: true });

    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    expect(summary.result?.isError).not.toBe(true);
    expect(summary.data.ssis.hasData).toBe(false);
    expect(summary.data.ssis.currentNav).toBeNull();
    expect(summary.data.ssis.totals.currentValue).toBeNull();
    expect(summary.data.ssis.totals.totalInvested.amountMinor).toBe("0");
    expect(summary.data.ssis.limitations.join(" ")).toContain("No SSIS data");

    const nav = await callTool(flow.tokens.accessToken, "get_ssis_nav_history");
    expect(nav.data.points).toEqual([]);
    expect(nav.data.currentNav).toBeNull();
  });

  it("partial dataset: NAV-only history resolves a current NAV with zero purchases", async () => {
    const user = await makeUser({ timezone: "UTC" });
    for (const [engDate, nepDate, navMinor] of [
      ["2024-01-31", "2080-10-17", 1010],
      ["2024-02-29", "2080-11-17", 1040]
    ] as const) {
      await db()
        .insert(ssisNavHistory)
        .values({ familyId: user.familyId, engDate, nepDate, navMinor });
    }
    const flow = await connectFlow(user, { ssisAccess: true });

    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    expect(summary.data.ssis.hasData).toBe(true);
    expect(summary.data.ssis.counts).toEqual({ purchases: 0, statementEntries: 0, navPoints: 2 });
    expect(summary.data.ssis.currentNav.amountMinor).toBe("1040");
    const nav = await callTool(flow.tokens.accessToken, "get_ssis_nav_history");
    expect(nav.data.currentNav).toMatchObject({ amountMinor: "1040", date: "2024-02-29" });
  });

  it("overflow totals surface as null, never a crash or a rounded number", async () => {
    const user = await makeUser({ timezone: "UTC" });
    // Two rows whose sum leaves the exactly-representable range; the
    // domain's safe conversion must turn the total into null.
    for (const requestNo of ["9001", "9002"]) {
      await db().insert(ssisPurchases).values({
        familyId: user.familyId,
        requestNo,
        applyDate: "2024-01-15",
        units: "1",
        amountMinor: Number.MAX_SAFE_INTEGER,
        status: "VERIFIED",
        purchaseNavMinor: 1000,
        navDate: "2024-01-15",
        schemeName: null,
        isSip: false
      });
    }
    await db().insert(ssisNavHistory).values({
      familyId: user.familyId,
      engDate: "2024-01-31",
      nepDate: "2080-10-17",
      navMinor: 1000
    });
    const flow = await connectFlow(user, { ssisAccess: true });

    const summary = await callTool(flow.tokens.accessToken, "get_ssis_summary");
    expect(summary.result?.isError).not.toBe(true);
    expect(summary.data.ssis.totals.totalInvested).toBeNull();
    expect(summary.data.ssis.totals.profit).toBeNull();
    // The representable figure (2 units × 10.00) is still exact.
    expect(summary.data.ssis.totals.currentValue.amountMinor).toBe("2000");
    expect(summary.data.ssis.limitations.join(" ")).toContain("exactly-representable");
  });
});
