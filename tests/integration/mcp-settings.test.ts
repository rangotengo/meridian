import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { actorOf, addTxn, db, makeAccount, makeUser, truncateAll, type TestUser } from "../helpers";
import { oauthGrants } from "@/server/db/schema";
import type { McpConfig } from "@/lib/env";
import { randomToken } from "@/lib/crypto";
import {
  OAuthError,
  approveAuthorizationRequest,
  consumeAuthorizationRequest,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  listConnectionsForUser,
  listGrantsForUser,
  registerOAuthClient,
  resolveOAuthClient,
  revokeGrant,
  validateAuthorizeRequest,
  type AuthorizeRequest,
  type OAuthGrantRow,
  type TokenSuccess
} from "@/server/domain/oauth";
import { POST as mcpPost } from "@/app/mcp/route";

// Stage 4: Connected AI agents settings data + consent account picker.
// The settings list is exercised through listConnectionsForUser (the
// exact function the settings page renders from); the picker is
// exercised through the real consent flow — create record, consume it,
// approve with a selection — never by writing grant rows directly.

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
const SCOPES = ["finance:read", "transactions:read", "offline_access"];

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

/**
 * Drive the consent flow exactly as the routes do. When `selection` is
 * given it is passed to approval the way the consent action passes the
 * picker's submitted account ids.
 */
async function connectFlow(
  user: TestUser,
  opts: { clientName?: string; selection?: string[] } = {}
): Promise<Flow> {
  const exec = db();
  const { client: dcr } = await registerOAuthClient(exec, {
    clientName: opts.clientName ?? "Claude",
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
      scope: SCOPES.join(" "),
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
    opts.selection ? { actor, accountIds: opts.selection } : undefined
  );
  const tokens = await exchangeAuthorizationCode(
    exec,
    { code, redirectUri: LOOPBACK, codeVerifier: verifier, resource: CONFIG.resourceUrl },
    client,
    CONFIG
  );
  return { grant, tokens };
}

/** Attempt an approval with a selection, returning the error if it fails. */
async function approveWithSelection(
  user: TestUser,
  selection: string[]
): Promise<{ grant?: OAuthGrantRow; error?: unknown }> {
  const exec = db();
  const { client: dcr } = await registerOAuthClient(exec, {
    clientName: "Picker Probe",
    redirectUris: [LOOPBACK]
  });
  const client = (await resolveOAuthClient(exec, dcr.id))!;
  const { challenge } = pkce();
  const request = await validateAuthorizeRequest(
    exec,
    {
      clientId: client.clientId,
      redirectUri: LOOPBACK,
      responseType: "code",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: SCOPES.join(" "),
      resource: CONFIG.resourceUrl,
      state: null
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
  try {
    const { grant } = await approveAuthorizationRequest(exec, consumed, CONFIG, {
      actor,
      accountIds: selection
    });
    return { grant };
  } catch (error) {
    return { error };
  }
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

describe("settings: connection list", () => {
  it("lists only the signed-in user's connections, with household and status", async () => {
    const alice = await makeUser({ familyName: "Alice Household" });
    const bob = await makeUser({ familyName: "Bob Household" });
    const aliceFlow = await connectFlow(alice, { clientName: "Claude" });
    await connectFlow(bob, { clientName: "ChatGPT" });

    const aliceConnections = await listConnectionsForUser(db(), alice.userId);
    expect(aliceConnections).toHaveLength(1);
    const conn = aliceConnections[0]!;
    expect(conn.grant.id).toBe(aliceFlow.grant.id);
    expect(conn.grant.clientName).toBe("Claude");
    expect(conn.familyName).toBe("Alice Household");
    expect(conn.status).toBe("active");
    expect(conn.accounts).toBeNull(); // no ceiling = all accessible accounts
    expect(conn.grant.lastUsedAt).toBeNull();
    expect(conn.history.map((h) => h.action)).toEqual(["oauth_grant.created"]);

    const bobConnections = await listConnectionsForUser(db(), bob.userId);
    expect(bobConnections).toHaveLength(1);
    expect(bobConnections[0]!.grant.clientName).toBe("ChatGPT");

    const stranger = await makeUser();
    expect(await listConnectionsForUser(db(), stranger.userId)).toEqual([]);
  });

  it("reports expired grants as expired", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user);
    await db()
      .update(oauthGrants)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(oauthGrants.id, flow.grant.id));
    const [conn] = await listConnectionsForUser(db(), user.userId);
    expect(conn!.status).toBe("expired");
  });
});

describe("consent account picker", () => {
  it("stores the validated subset on the grant and the subset constrains tool results", async () => {
    const user = await makeUser();
    const kept = await makeAccount(user, {
      name: "Kept Account",
      openingBalanceDisplayMinor: 10_000
    });
    const hidden = await makeAccount(user, {
      name: "Hidden Account",
      openingBalanceDisplayMinor: 20_000
    });
    await addTxn(user, kept, { amountLedgerMinor: 1_000, name: "Kept txn" });
    await addTxn(user, hidden, { amountLedgerMinor: 2_000, name: "Hidden txn" });

    const flow = await connectFlow(user, { selection: [kept] });
    expect(flow.grant.accountIds).toEqual([kept]);

    const listed = await callTool(flow.tokens.accessToken, "list_accounts");
    expect(listed.result?.isError).toBeFalsy();
    const ids = (listed.data.accounts as { id: string }[]).map((a) => a.id);
    expect(ids).toEqual([kept]);

    const searched = await callTool(flow.tokens.accessToken, "search_transactions", {});
    const accountIds = [
      ...new Set((searched.data.transactions as { accountId: string }[]).map((t) => t.accountId))
    ];
    expect(accountIds).toEqual([kept]);

    // The settings list names the ceiling accounts.
    const [conn] = await listConnectionsForUser(db(), user.userId);
    expect(conn!.accounts).toEqual([{ id: kept, name: "Kept Account" }]);
  });

  it("stores an empty ceiling when every accessible account is selected", async () => {
    const user = await makeUser();
    const a = await makeAccount(user);
    const b = await makeAccount(user);
    const flow = await connectFlow(user, { selection: [b, a] }); // order must not matter
    expect(flow.grant.accountIds).toEqual([]);
    const [conn] = await listConnectionsForUser(db(), user.userId);
    expect(conn!.accounts).toBeNull();
  });

  it("rejects an account the user cannot access, minting no grant", async () => {
    const user = await makeUser();
    const own = await makeAccount(user);
    const otherUser = await makeUser();
    const foreign = await makeAccount(otherUser);

    const foreignOnly = await approveWithSelection(user, [foreign]);
    expect(foreignOnly.grant).toBeUndefined();
    expect(foreignOnly.error).toBeInstanceOf(OAuthError);
    expect((foreignOnly.error as OAuthError).error).toBe("invalid_request");

    // Fail closed even when the inaccessible id is mixed with valid ones.
    const mixed = await approveWithSelection(user, [own, foreign]);
    expect(mixed.grant).toBeUndefined();
    expect(mixed.error).toBeInstanceOf(OAuthError);

    expect(await listGrantsForUser(db(), user.userId)).toEqual([]);
  });

  it("rejects an empty selection", async () => {
    const user = await makeUser();
    await makeAccount(user);
    const { grant, error } = await approveWithSelection(user, []);
    expect(grant).toBeUndefined();
    expect(error).toBeInstanceOf(OAuthError);
    expect(await listGrantsForUser(db(), user.userId)).toEqual([]);
  });
});

describe("last used + access history", () => {
  it("advances lastUsedAt on a tool call and records metadata-only history", async () => {
    const user = await makeUser();
    await makeAccount(user, { openingBalanceDisplayMinor: 5_000 });
    const flow = await connectFlow(user);
    expect(flow.grant.lastUsedAt).toBeNull();

    const call = await callTool(flow.tokens.accessToken, "get_financial_summary");
    expect(call.result?.isError).toBeFalsy();

    const [after] = await listGrantsForUser(db(), user.userId);
    expect(after!.lastUsedAt).not.toBeNull();
    expect(after!.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(after!.createdAt.getTime());

    await revokeGrant(db(), flow.grant.id, user.userId);

    const [conn] = await listConnectionsForUser(db(), user.userId);
    expect(conn!.status).toBe("revoked");
    expect(conn!.grant.lastUsedAt).not.toBeNull();
    // Newest first: revoked, then the tool call, then creation.
    expect(conn!.history.map((h) => h.action)).toEqual([
      "oauth_grant.revoked",
      "mcp.tool_called",
      "oauth_grant.created"
    ]);
    const toolEntry = conn!.history.find((h) => h.action === "mcp.tool_called");
    expect(toolEntry!.tool).toBe("get_financial_summary");
  });
});
