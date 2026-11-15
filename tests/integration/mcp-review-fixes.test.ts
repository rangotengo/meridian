import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { actorOf, db, makeUser, truncateAll, type TestUser } from "../helpers";
import * as schema from "@/server/db/schema";
import {
  oauthAssertionClaims,
  oauthAuthorizationCodes,
  oauthAuthorizationRequests,
  oauthClients,
  oauthGrants,
  oauthTokens
} from "@/server/db/schema";
import type { McpConfig } from "@/lib/env";
import { hashToken, randomToken } from "@/lib/crypto";
import {
  OAuthError,
  approveAuthorizationRequest,
  cleanupOAuthHousekeeping,
  consumeAuthorizationRequest,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  refreshOAuthToken,
  registerOAuthClient,
  resolveMcpAccess,
  resolveOAuthClient,
  validateAuthorizeRequest,
  type AuthorizeRequest,
  type OAuthGrantRow,
  type ResolvedClient,
  type TokenSuccess
} from "@/server/domain/oauth";
import { buildFamilyExport } from "@/server/domain/exports";
import { buildInstanceExport } from "@/server/domain/backups";

// Regression coverage for the PR #13 owner review (review 5910065813):
// the P1-2 replay/revocation races use REAL database interleavings —
// a table lock pauses the winning exchange mid-issuance, and a row lock
// pauses the revocation sweep mid-update — rather than timing guesses.

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

function pkce() {
  const verifier = randomToken(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function expectOAuthError(promise: Promise<unknown>, error: string) {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(OAuthError);
    expect((e as OAuthError).error).toBe(error);
    return;
  }
  throw new Error(`Expected OAuthError ${error}, but the call succeeded.`);
}

type Flow = {
  client: ResolvedClient;
  grant: OAuthGrantRow;
  code: string;
  verifier: string;
  tokens: TokenSuccess;
};

async function approveOnly(user: TestUser): Promise<Omit<Flow, "tokens">> {
  const exec = db();
  const { client: dcr } = await registerOAuthClient(exec, {
    clientName: "Review Client",
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
      scope: "finance:read offline_access",
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
  const { grant, code } = await approveAuthorizationRequest(exec, consumed, CONFIG);
  return { client, grant, code, verifier };
}

async function connectFlow(user: TestUser): Promise<Flow> {
  const base = await approveOnly(user);
  const tokens = await exchangeAuthorizationCode(
    db(),
    {
      code: base.code,
      redirectUri: LOOPBACK,
      codeVerifier: base.verifier,
      resource: CONFIG.resourceUrl
    },
    base.client,
    CONFIG
  );
  return { ...base, tokens };
}

function separateExec() {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  return { pool, exec: drizzle(pool, { schema }) as unknown as ReturnType<typeof db> };
}

async function pollUntil(check: () => Promise<boolean>, description: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

/** Is any backend currently blocked on a lock for a statement touching
 * the given table? (Observed via pg_stat_activity — deterministic
 * interleave points for the race repros.) */
async function backendBlockedOn(table: string): Promise<boolean> {
  const res = await db().execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND query ILIKE ${"%" + table + "%"}
  `);
  return Number(res.rows?.[0]?.n ?? 0) > 0;
}

beforeAll(async () => {
  await truncateAll();
});

describe("P1-2: durable family invalidation under real interleavings", () => {
  it("replay during a paused first issuance leaves no usable tokens", async () => {
    const user = await makeUser();
    const { client, grant, code, verifier } = await approveOnly(user);
    const input = {
      code,
      redirectUri: LOOPBACK,
      codeVerifier: verifier,
      resource: CONFIG.resourceUrl
    };

    const locker = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const lockClient = await locker.connect();
    const winner = separateExec();
    const replay = separateExec();
    try {
      // Pause the winner AFTER it consumes the code but BEFORE its
      // first token insert can complete: SHARE ROW EXCLUSIVE conflicts
      // with the INSERT's ROW EXCLUSIVE table lock.
      await lockClient.query("BEGIN");
      await lockClient.query("LOCK TABLE oauth_tokens IN SHARE ROW EXCLUSIVE MODE");

      const winnerPromise = exchangeAuthorizationCode(winner.exec, input, client, CONFIG);
      await pollUntil(
        async () => backendBlockedOn("oauth_tokens"),
        "winner blocked inserting its first token"
      );
      // The winner has consumed the code and is mid-issuance. A replay
      // now must not be able to "win" by revoking an empty family.
      const replayPromise = exchangeAuthorizationCode(replay.exec, input, client, CONFIG).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      );
      // Give the replay time to reach its block on the code row lock
      // (held by the winner's issuance transaction).
      await new Promise((resolve) => setTimeout(resolve, 300));
      await lockClient.query("COMMIT");

      const winnerTokens = await winnerPromise;
      const replayOutcome = await replayPromise;
      expect(replayOutcome.ok).toBe(false);
      expect((replayOutcome as { error: OAuthError }).error.error).toBe("invalid_grant");

      // The winner's freshly minted credentials are dead: the replay's
      // invalidation revoked them, and the persistent marker makes
      // verification reject them regardless of sweep timing.
      expect(await resolveMcpAccess(db(), winnerTokens.accessToken, CONFIG)).toBeNull();
      await expectOAuthError(
        refreshOAuthToken(db(), { refreshToken: winnerTokens.refreshToken! }, client, CONFIG),
        "invalid_grant"
      );
      const [codeRow] = await db()
        .select()
        .from(oauthAuthorizationCodes)
        .where(eq(oauthAuthorizationCodes.id, await codeRowId(code)));
      expect(codeRow!.invalidatedAt).not.toBeNull();
      const [grantRow] = await db().select().from(oauthGrants).where(eq(oauthGrants.id, grant.id));
      expect(grantRow!.status).toBe("revoked");
    } finally {
      lockClient.release();
      await locker.end();
      await winner.pool.end();
      await replay.pool.end();
    }
  });

  it("replay blocked mid-revocation cannot be outrun by a descendant refresh", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user);
    const client = flow.client;
    // Rotate A -> B (committed). A is now a rotated-out token.
    const pairB = await refreshOAuthToken(
      db(),
      { refreshToken: flow.tokens.refreshToken! },
      client,
      CONFIG
    );
    expect(await resolveMcpAccess(db(), pairB.accessToken, CONFIG)).not.toBeNull();

    const [aRow] = await db()
      .select({ id: oauthTokens.id })
      .from(oauthTokens)
      .where(eq(oauthTokens.tokenHash, hashToken(flow.tokens.refreshToken!)));
    const locker = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const lockClient = await locker.connect();
    const replay = separateExec();
    const descendant = separateExec();
    try {
      // Lock A's row: the replay's revocation work must block on it.
      await lockClient.query("BEGIN");
      await lockClient.query("SELECT id FROM oauth_tokens WHERE id = $1 FOR UPDATE", [aRow!.id]);

      const replayPromise = refreshOAuthToken(
        replay.exec,
        { refreshToken: flow.tokens.refreshToken! },
        client,
        CONFIG
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      );
      await pollUntil(
        async () => backendBlockedOn("oauth_tokens"),
        "replay blocked inside its revocation transaction"
      );
      // While the replay is stuck mid-revocation, a descendant refresh
      // (B -> C) must NOT slip past and mint a surviving pair.
      const descendantPromise = refreshOAuthToken(
        descendant.exec,
        { refreshToken: pairB.refreshToken! },
        client,
        CONFIG
      ).then(
        (pair) => ({ ok: true as const, pair }),
        (error: unknown) => ({ ok: false as const, error })
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await lockClient.query("COMMIT");

      const replayOutcome = await replayPromise;
      expect(replayOutcome.ok).toBe(false);
      expect((replayOutcome as { error: OAuthError }).error.error).toBe("invalid_grant");

      const descendantOutcome = await descendantPromise;
      expect(descendantOutcome.ok).toBe(false);
      expect((descendantOutcome as { error: OAuthError }).error.error).toBe("invalid_grant");

      // Nothing in the family survives: B's pair is revoked, no C pair
      // exists, and the grant itself is revoked.
      expect(await resolveMcpAccess(db(), pairB.accessToken, CONFIG)).toBeNull();
      const liveTokens = await db()
        .select({ id: oauthTokens.id })
        .from(oauthTokens)
        .where(and(eq(oauthTokens.grantId, flow.grant.id), isNull(oauthTokens.revokedAt)));
      expect(liveTokens).toHaveLength(0);
      const [grantRow] = await db()
        .select()
        .from(oauthGrants)
        .where(eq(oauthGrants.id, flow.grant.id));
      expect(grantRow!.status).toBe("revoked");
    } finally {
      lockClient.release();
      await locker.end();
      await replay.pool.end();
      await descendant.pool.end();
    }
  });
});

async function codeRowId(code: string): Promise<string> {
  const [row] = await db()
    .select({ id: oauthAuthorizationCodes.id })
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, hashToken(code)));
  return row!.id;
}

describe("P2-8: stored resource governs exchange and refresh", () => {
  const CONFIG_B: McpConfig = { ...CONFIG, resourceUrl: "https://other-resource.test/mcp" };

  it("refresh under a changed canonical resource is rejected; the original still works", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user);
    // Config moved to resource B after the connection was made under A.
    // The stored row says A, so the refresh must fail — not mint
    // resource-B credentials from a resource-A token.
    await expectOAuthError(
      refreshOAuthToken(
        db(),
        { refreshToken: flow.tokens.refreshToken!, resource: CONFIG_B.resourceUrl },
        flow.client,
        CONFIG_B
      ),
      "invalid_grant"
    );
    // The rejection did not consume or rotate the token: under the
    // original configuration the same refresh still succeeds, and the
    // pair it mints keeps the original audience.
    const pair = await refreshOAuthToken(
      db(),
      { refreshToken: flow.tokens.refreshToken! },
      flow.client,
      CONFIG
    );
    expect(await resolveMcpAccess(db(), pair.accessToken, CONFIG)).not.toBeNull();
    expect(await resolveMcpAccess(db(), pair.accessToken, CONFIG_B)).toBeNull();
  });

  it("code exchange under a changed canonical resource is rejected", async () => {
    const user = await makeUser();
    const { client, code, verifier } = await approveOnly(user);
    await expectOAuthError(
      exchangeAuthorizationCode(
        db(),
        {
          code,
          redirectUri: LOOPBACK,
          codeVerifier: verifier,
          resource: CONFIG_B.resourceUrl
        },
        client,
        CONFIG_B
      ),
      "invalid_grant"
    );
  });
});

describe("F1: OAuth housekeeping bounds growth", () => {
  it("prunes expired claims/records and stale never-used DCR clients only", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user);
    const { client: stale } = await registerOAuthClient(db(), {
      clientName: "Stale",
      redirectUris: [LOOPBACK]
    });
    const { client: staleUsed } = await registerOAuthClient(db(), {
      clientName: "StaleUsed",
      redirectUris: [LOOPBACK]
    });
    await db()
      .insert(oauthGrants)
      .values({
        userId: user.userId,
        familyId: user.familyId,
        clientId: staleUsed.id,
        clientName: "StaleUsed",
        scopes: ["finance:read"],
        accountIds: [],
        status: "active",
        expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000)
      });
    await db().execute(
      sql`UPDATE oauth_clients SET created_at = now() - interval '31 days' WHERE id IN (${stale.id}, ${staleUsed.id})`
    );

    const now = new Date();
    await db()
      .insert(oauthAssertionClaims)
      .values([
        {
          clientId: "housekeeping-client",
          jti: "expired-claim",
          expiresAt: new Date(now.getTime() - 60_000)
        },
        {
          clientId: "housekeeping-client",
          jti: "live-claim",
          expiresAt: new Date(now.getTime() + 60_000)
        }
      ]);
    const requestBase = {
      userId: user.userId,
      familyId: user.familyId,
      sessionId: "housekeeping-session",
      clientId: flow.client.clientId,
      clientName: "Review Client",
      redirectUri: LOOPBACK,
      scopes: ["finance:read"],
      resource: CONFIG.resourceUrl,
      codeChallenge: "housekeeping-challenge",
      csrfTokenHash: "housekeeping-csrf"
    };
    await db()
      .insert(oauthAuthorizationRequests)
      .values([
        { ...requestBase, expiresAt: new Date(now.getTime() - 2 * 24 * 3600 * 1000) },
        { ...requestBase, expiresAt: new Date(now.getTime() + 600_000) }
      ]);

    const result = await cleanupOAuthHousekeeping(db(), now);
    expect(result.staleClientsDeleted).toBe(1);
    expect(result.assertionClaimsDeleted).toBe(1);
    expect(result.authorizationRequestsDeleted).toBe(1);

    const remainingClients = await db()
      .select({ id: oauthClients.id })
      .from(oauthClients)
      .where(sql`${oauthClients.id} IN (${stale.id}, ${staleUsed.id}, ${flow.client.clientId})`);
    expect(remainingClients.map((c) => c.id).sort()).toEqual(
      [staleUsed.id, flow.client.clientId].sort()
    );
    const remainingClaims = await db()
      .select({ jti: oauthAssertionClaims.jti })
      .from(oauthAssertionClaims)
      .where(eq(oauthAssertionClaims.clientId, "housekeeping-client"));
    expect(remainingClaims.map((c) => c.jti)).toEqual(["live-claim"]);
  });
});

describe("F3: backup/restore contract for OAuth state", () => {
  it("household export carries no OAuth state; instance export includes it", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user);

    const household = await buildFamilyExport(db(), actorOf(user));
    for (const key of Object.keys(household)) {
      expect(key).not.toMatch(/oauth/i);
    }
    const householdJson = JSON.stringify(household);
    expect(householdJson).not.toContain(flow.grant.id);
    expect(householdJson).not.toContain(hashToken(flow.tokens.accessToken));

    const instance = await buildInstanceExport(db());
    expect((instance.tables.oauthGrants ?? []).length).toBeGreaterThanOrEqual(1);
    expect((instance.tables.oauthTokens ?? []).length).toBeGreaterThanOrEqual(2);
    expect((instance.tables.oauthClients ?? []).length).toBeGreaterThanOrEqual(1);
    expect((instance.tables.oauthAuthorizationCodes ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
