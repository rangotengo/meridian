import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  actorOf,
  addTxn,
  db,
  latestBalance,
  makeAccount,
  makeSuperAdmin,
  makeUser,
  truncateAll,
  type TestUser
} from "../helpers";
import * as schema from "@/server/db/schema";
import { users } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import type { McpConfig } from "@/lib/env";
import { hashToken, randomToken } from "@/lib/crypto";
import {
  OAuthError,
  approveAuthorizationRequest,
  authenticateOAuthClient,
  consumeAuthorizationRequest,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  refreshOAuthToken,
  registerOAuthClient,
  resolveMcpAccess,
  resolveOAuthClient,
  revokeGrant,
  revokeOAuthToken,
  validateAuthorizeRequest,
  type AuthorizeRequest,
  type OAuthGrantRow,
  type ResolvedClient,
  type TokenSuccess
} from "@/server/domain/oauth";
import { clearCimdCaches } from "@/server/mcp/cimd";
import { createMetadataFetcher, SsrfError, type MetadataFetcher } from "@/server/mcp/ssrf";
import { POST as mcpPost } from "@/app/mcp/route";
import { GET as prmGet } from "@/app/.well-known/oauth-protected-resource/mcp/route";
import { GET as asMetadataGet } from "@/app/.well-known/oauth-authorization-server/route";
import { POST as tokenPost } from "@/app/oauth/token/route";
import { POST as registerPost } from "@/app/oauth/register/route";
import { POST as revokePost } from "@/app/oauth/revoke/route";

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
  redirectUri: string;
  tokens: TokenSuccess;
};

/** Drive the full consent flow at service level, exactly as the routes do. */
async function connectFlow(
  user: TestUser,
  opts: {
    clientName?: string;
    scopes?: string[];
    redirectUri?: string;
    exec?: ReturnType<typeof db>;
  } = {}
): Promise<Flow> {
  const exec = opts.exec ?? db();
  const redirectUri = opts.redirectUri ?? LOOPBACK;
  const { client: dcr } = await registerOAuthClient(exec, {
    clientName: opts.clientName ?? "Claude",
    redirectUris: [redirectUri]
  });
  const client = (await resolveOAuthClient(exec, dcr.id))!;
  const { verifier, challenge } = pkce();
  const request: AuthorizeRequest = await validateAuthorizeRequest(
    exec,
    {
      clientId: client.clientId,
      redirectUri,
      responseType: "code",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: (opts.scopes ?? ["finance:read", "offline_access"]).join(" "),
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
  const tokens = await exchangeAuthorizationCode(
    exec,
    { code, redirectUri, codeVerifier: verifier, resource: CONFIG.resourceUrl },
    client,
    CONFIG
  );
  return { client, grant, code, verifier, redirectUri, tokens };
}

beforeAll(async () => {
  await truncateAll();
});

describe("authorization server: happy path", () => {
  it("connects end to end and resolves access bound to the household", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user);
    expect(flow.tokens.tokenType).toBe("Bearer");
    expect(flow.tokens.refreshToken).toBeTruthy();
    expect(flow.tokens.scope).toContain("finance:read");

    const access = await resolveMcpAccess(db(), flow.tokens.accessToken, CONFIG);
    expect(access).not.toBeNull();
    expect(access!.actor.userId).toBe(user.userId);
    expect(access!.actor.familyId).toBe(user.familyId);
    expect(access!.actor.platformRole).toBe("user");
    expect(access!.actor.authProvider).toBe("oauth");
    expect(access!.grant.id).toBe(flow.grant.id);
  });

  it("omits the refresh token when offline_access was not granted", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user, { scopes: ["finance:read"] });
    expect(flow.tokens.refreshToken).toBeUndefined();
  });

  it("defaults scopes when the client does not request any", async () => {
    const { client } = await registerOAuthClient(db(), {
      clientName: "NoScope",
      redirectUris: [LOOPBACK]
    });
    const { challenge } = pkce();
    const request = await validateAuthorizeRequest(
      db(),
      {
        clientId: client.id,
        redirectUri: LOOPBACK,
        responseType: "code",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        scope: null,
        resource: null,
        state: null
      },
      CONFIG
    );
    expect(request.scopes).toEqual(["finance:read", "transactions:read"]);
  });
});

describe("authorization request validation", () => {
  it("rejects PKCE downgrade: plain method, missing method, missing challenge", async () => {
    const { client } = await registerOAuthClient(db(), {
      clientName: "Pkce",
      redirectUris: [LOOPBACK]
    });
    const { challenge } = pkce();
    const base = {
      clientId: client.id,
      redirectUri: LOOPBACK,
      responseType: "code",
      resource: CONFIG.resourceUrl,
      scope: "finance:read",
      state: null
    };
    await expectOAuthError(
      validateAuthorizeRequest(
        db(),
        { ...base, codeChallenge: challenge, codeChallengeMethod: "plain" },
        CONFIG
      ),
      "invalid_request"
    );
    await expectOAuthError(
      validateAuthorizeRequest(
        db(),
        { ...base, codeChallenge: challenge, codeChallengeMethod: null },
        CONFIG
      ),
      "invalid_request"
    );
    await expectOAuthError(
      validateAuthorizeRequest(
        db(),
        { ...base, codeChallenge: null, codeChallengeMethod: "S256" },
        CONFIG
      ),
      "invalid_request"
    );
  });

  it("rejects unregistered redirect URIs, wrong resource, unknown scopes, non-code response types", async () => {
    const { client } = await registerOAuthClient(db(), {
      clientName: "Strict",
      redirectUris: [LOOPBACK]
    });
    const { challenge } = pkce();
    const base = {
      clientId: client.id,
      redirectUri: LOOPBACK,
      responseType: "code",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      resource: CONFIG.resourceUrl,
      scope: "finance:read",
      state: null
    };
    await expectOAuthError(
      validateAuthorizeRequest(db(), { ...base, redirectUri: "https://chatgpt.com/other" }, CONFIG),
      "invalid_request"
    );
    await expectOAuthError(
      validateAuthorizeRequest(db(), { ...base, resource: "https://meridian.test/other" }, CONFIG),
      "invalid_target"
    );
    await expectOAuthError(
      validateAuthorizeRequest(db(), { ...base, scope: "finance:write" }, CONFIG),
      "invalid_scope"
    );
    await expectOAuthError(
      validateAuthorizeRequest(db(), { ...base, responseType: "token" }, CONFIG),
      "unsupported_response_type"
    );
    await expectOAuthError(
      validateAuthorizeRequest(db(), { ...base, clientId: "mcp_unknown" }, CONFIG),
      "invalid_client"
    );
  });

  it("loopback exception is port-only: different host, path, or query is a different callback (P1-5)", async () => {
    const { client } = await registerOAuthClient(db(), {
      clientName: "Loopback",
      redirectUris: [LOOPBACK]
    });
    const { challenge } = pkce();
    const base = {
      clientId: client.id,
      responseType: "code",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      resource: CONFIG.resourceUrl,
      scope: "finance:read",
      state: null
    };
    // RFC 8252 §7.3: a different PORT on the same loopback host, path,
    // and query is the registered callback.
    const okPort = await validateAuthorizeRequest(
      db(),
      { ...base, redirectUri: "http://127.0.0.1:9999/callback" },
      CONFIG
    );
    expect(okPort.redirectUri).toBe("http://127.0.0.1:9999/callback");
    // A different loopback HOST is not the registered callback.
    await expectOAuthError(
      validateAuthorizeRequest(
        db(),
        { ...base, redirectUri: "http://localhost:8910/callback" },
        CONFIG
      ),
      "invalid_request"
    );
    // An added QUERY is not the registered callback.
    await expectOAuthError(
      validateAuthorizeRequest(
        db(),
        { ...base, redirectUri: "http://127.0.0.1:8910/callback?next=https://evil.test" },
        CONFIG
      ),
      "invalid_request"
    );
    // A different PATH is not the registered callback.
    await expectOAuthError(
      validateAuthorizeRequest(
        db(),
        { ...base, redirectUri: "http://127.0.0.1:8910/other" },
        CONFIG
      ),
      "invalid_request"
    );
  });

  it("rejects a wrong PKCE verifier at exchange — and the attempt consumes the code", async () => {
    const user = await makeUser();
    const { client: dcr } = await registerOAuthClient(db(), {
      clientName: "Verifier",
      redirectUris: [LOOPBACK]
    });
    const client = (await resolveOAuthClient(db(), dcr.id))!;
    const { verifier, challenge } = pkce();
    const request = await validateAuthorizeRequest(
      db(),
      {
        clientId: client.clientId,
        redirectUri: LOOPBACK,
        responseType: "code",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        scope: "finance:read offline_access",
        resource: CONFIG.resourceUrl,
        state: null
      },
      CONFIG
    );
    const actor = actorOf(user);
    const { record, csrfToken } = await createAuthorizationRequest(db(), { actor, request });
    const consumed = await consumeAuthorizationRequest(db(), {
      requestId: record.id,
      actor,
      csrfToken
    });
    const { code } = await approveAuthorizationRequest(db(), consumed, CONFIG);
    await expectOAuthError(
      exchangeAuthorizationCode(
        db(),
        { code, redirectUri: LOOPBACK, codeVerifier: randomToken(32), resource: null },
        client,
        CONFIG
      ),
      "invalid_grant"
    );
    // The failed attempt consumed the code: even the correct verifier now fails.
    await expectOAuthError(
      exchangeAuthorizationCode(
        db(),
        { code, redirectUri: LOOPBACK, codeVerifier: verifier, resource: null },
        client,
        CONFIG
      ),
      "invalid_grant"
    );
  });

  it("rejects redirect_uri mismatch at the token endpoint", async () => {
    const user = await makeUser();
    const { client: dcr } = await registerOAuthClient(db(), {
      clientName: "Mismatch",
      redirectUris: [LOOPBACK, "http://127.0.0.1:8910/other"]
    });
    const client = (await resolveOAuthClient(db(), dcr.id))!;
    const { verifier, challenge } = pkce();
    const request = await validateAuthorizeRequest(
      db(),
      {
        clientId: client.clientId,
        redirectUri: LOOPBACK,
        responseType: "code",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        scope: "finance:read",
        resource: CONFIG.resourceUrl,
        state: null
      },
      CONFIG
    );
    const actor = actorOf(user);
    const { record, csrfToken } = await createAuthorizationRequest(db(), { actor, request });
    const consumed = await consumeAuthorizationRequest(db(), {
      requestId: record.id,
      actor,
      csrfToken
    });
    const { code } = await approveAuthorizationRequest(db(), consumed, CONFIG);
    await expectOAuthError(
      exchangeAuthorizationCode(
        db(),
        {
          code,
          redirectUri: "http://127.0.0.1:8910/other",
          codeVerifier: verifier,
          resource: null
        },
        client,
        CONFIG
      ),
      "invalid_grant"
    );
  });
});

describe("consent record binding", () => {
  it("rejects wrong CSRF, a different session, a different user, and double consumption", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const { client } = await registerOAuthClient(db(), {
      clientName: "Consent",
      redirectUris: [LOOPBACK]
    });
    const { challenge } = pkce();
    const request = await validateAuthorizeRequest(
      db(),
      {
        clientId: client.id,
        redirectUri: LOOPBACK,
        responseType: "code",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        scope: "finance:read",
        resource: CONFIG.resourceUrl,
        state: null
      },
      CONFIG
    );
    const actor = actorOf(user);
    const { record, csrfToken } = await createAuthorizationRequest(db(), { actor, request });

    await expectOAuthError(
      consumeAuthorizationRequest(db(), { requestId: record.id, actor, csrfToken: "bogus" }),
      "invalid_request"
    );
    await expectOAuthError(
      consumeAuthorizationRequest(db(), {
        requestId: record.id,
        actor: { ...actor, sessionId: "another-session" },
        csrfToken
      }),
      "invalid_request"
    );
    await expectOAuthError(
      consumeAuthorizationRequest(db(), { requestId: record.id, actor: actorOf(other), csrfToken }),
      "invalid_request"
    );
    const consumed = await consumeAuthorizationRequest(db(), {
      requestId: record.id,
      actor,
      csrfToken
    });
    expect(consumed.id).toBe(record.id);
    // Exactly once: a second decision on the same record is refused.
    await expectOAuthError(
      consumeAuthorizationRequest(db(), { requestId: record.id, actor, csrfToken }),
      "invalid_request"
    );
  });

  it("rejects consumption after the user's household changed since consent was shown", async () => {
    const user = await makeUser();
    const elsewhere = await makeUser();
    const { client } = await registerOAuthClient(db(), {
      clientName: "ConsentMove",
      redirectUris: [LOOPBACK]
    });
    const { challenge } = pkce();
    const request = await validateAuthorizeRequest(
      db(),
      {
        clientId: client.id,
        redirectUri: LOOPBACK,
        responseType: "code",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        scope: "finance:read",
        resource: CONFIG.resourceUrl,
        state: null
      },
      CONFIG
    );
    const actor = actorOf(user);
    const { record, csrfToken } = await createAuthorizationRequest(db(), { actor, request });
    await expectOAuthError(
      consumeAuthorizationRequest(db(), {
        requestId: record.id,
        actor: { ...actor, familyId: elsewhere.familyId },
        csrfToken
      }),
      "invalid_request"
    );
  });
});

describe("code replay and concurrency (separate connections)", () => {
  function separateExec() {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    return { pool, exec: drizzle(pool, { schema }) as unknown as ReturnType<typeof db> };
  }

  it("sequential replay via a separate connection is rejected and kills the first tokens", async () => {
    const user = await makeUser();
    const a = separateExec();
    const b = separateExec();
    try {
      const flow = await connectFlow(user, { exec: a.exec });
      await expectOAuthError(
        exchangeAuthorizationCode(
          b.exec,
          {
            code: flow.code,
            redirectUri: flow.redirectUri,
            codeVerifier: flow.verifier,
            resource: CONFIG.resourceUrl
          },
          flow.client,
          CONFIG
        ),
        "invalid_grant"
      );
      expect(await resolveMcpAccess(db(), flow.tokens.accessToken, CONFIG)).toBeNull();
    } finally {
      await a.pool.end();
      await b.pool.end();
    }
  });

  it("simultaneous exchanges of one code: exactly one succeeds", async () => {
    const user = await makeUser();
    const { client: dcr } = await registerOAuthClient(db(), {
      clientName: "Race",
      redirectUris: [LOOPBACK]
    });
    const client = (await resolveOAuthClient(db(), dcr.id))!;
    const { verifier, challenge } = pkce();
    const request = await validateAuthorizeRequest(
      db(),
      {
        clientId: client.clientId,
        redirectUri: LOOPBACK,
        responseType: "code",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        scope: "finance:read offline_access",
        resource: CONFIG.resourceUrl,
        state: null
      },
      CONFIG
    );
    const actor = actorOf(user);
    const { record, csrfToken } = await createAuthorizationRequest(db(), { actor, request });
    const consumed = await consumeAuthorizationRequest(db(), {
      requestId: record.id,
      actor,
      csrfToken
    });
    const { code } = await approveAuthorizationRequest(db(), consumed, CONFIG);

    const a = separateExec();
    const b = separateExec();
    try {
      const input = {
        code,
        redirectUri: LOOPBACK,
        codeVerifier: verifier,
        resource: CONFIG.resourceUrl
      };
      const results = await Promise.allSettled([
        exchangeAuthorizationCode(a.exec, input, client, CONFIG),
        exchangeAuthorizationCode(b.exec, input, client, CONFIG)
      ]);
      const winners = results.filter((r) => r.status === "fulfilled");
      expect(winners.length).toBe(1);
      // The loser's replay handling revokes the family, so even the
      // winner's freshly minted tokens are dead (BCP replay defense).
      const winnerTokens = (winners[0] as PromiseFulfilledResult<TokenSuccess>).value;
      expect(await resolveMcpAccess(db(), winnerTokens.accessToken, CONFIG)).toBeNull();
    } finally {
      await a.pool.end();
      await b.pool.end();
    }
  });
});

describe("refresh token rotation and reuse", () => {
  it("rotates, and replaying a rotated-out token revokes the whole family", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user);
    const client = flow.client;
    const pair2 = await refreshOAuthToken(
      db(),
      { refreshToken: flow.tokens.refreshToken!, resource: null },
      client,
      CONFIG
    );
    expect(pair2.refreshToken).toBeTruthy();
    expect(pair2.refreshToken).not.toBe(flow.tokens.refreshToken);
    expect(await resolveMcpAccess(db(), pair2.accessToken, CONFIG)).not.toBeNull();

    // Replay the rotated-out token: reuse detection engages.
    await expectOAuthError(
      refreshOAuthToken(db(), { refreshToken: flow.tokens.refreshToken! }, client, CONFIG),
      "invalid_grant"
    );
    // The whole family — including pair2 — is now dead.
    expect(await resolveMcpAccess(db(), pair2.accessToken, CONFIG)).toBeNull();
    await expectOAuthError(
      refreshOAuthToken(db(), { refreshToken: pair2.refreshToken! }, client, CONFIG),
      "invalid_grant"
    );
  });

  it("simultaneous refreshes with one token: exactly one succeeds, reuse handling engages", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user);
    const poolA = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const poolB = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const execA = drizzle(poolA, { schema }) as unknown as ReturnType<typeof db>;
    const execB = drizzle(poolB, { schema }) as unknown as ReturnType<typeof db>;
    try {
      const input = { refreshToken: flow.tokens.refreshToken!, resource: null };
      const results = await Promise.allSettled([
        refreshOAuthToken(execA, input, flow.client, CONFIG),
        refreshOAuthToken(execB, input, flow.client, CONFIG)
      ]);
      const winners = results.filter((r) => r.status === "fulfilled");
      expect(winners.length).toBe(1);
      const winnerTokens = (winners[0] as PromiseFulfilledResult<TokenSuccess>).value;
      expect(await resolveMcpAccess(db(), winnerTokens.accessToken, CONFIG)).toBeNull();
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });
});

describe("revocation and reconnect", () => {
  it("two connections for one user: revoking one leaves the other working", async () => {
    const user = await makeUser();
    const claude = await connectFlow(user, { clientName: "Claude" });
    const chatgpt = await connectFlow(user, { clientName: "ChatGPT" });
    expect(claude.grant.id).not.toBe(chatgpt.grant.id);

    expect(await revokeGrant(db(), claude.grant.id, user.userId)).toBe(true);
    expect(await resolveMcpAccess(db(), claude.tokens.accessToken, CONFIG)).toBeNull();
    expect(await resolveMcpAccess(db(), chatgpt.tokens.accessToken, CONFIG)).not.toBeNull();

    // Another user's id cannot revoke it.
    const stranger = await makeUser();
    expect(await revokeGrant(db(), chatgpt.grant.id, stranger.userId)).toBe(false);
    expect(await resolveMcpAccess(db(), chatgpt.tokens.accessToken, CONFIG)).not.toBeNull();
  });

  it("reconnect creates a NEW grant; the revoked grant's access and refresh tokens stay dead", async () => {
    const user = await makeUser();
    const first = await connectFlow(user, { clientName: "Claude" });
    await revokeGrant(db(), first.grant.id, user.userId);

    const second = await connectFlow(user, { clientName: "Claude" });
    expect(second.grant.id).not.toBe(first.grant.id);
    expect(await resolveMcpAccess(db(), second.tokens.accessToken, CONFIG)).not.toBeNull();

    expect(await resolveMcpAccess(db(), first.tokens.accessToken, CONFIG)).toBeNull();
    await expectOAuthError(
      refreshOAuthToken(db(), { refreshToken: first.tokens.refreshToken! }, first.client, CONFIG),
      "invalid_grant"
    );
  });

  it("RFC 7009 revocation: access token dies at once; refresh revocation kills the family", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user);
    await revokeOAuthToken(db(), {
      token: flow.tokens.accessToken,
      clientId: flow.client.clientId
    });
    expect(await resolveMcpAccess(db(), flow.tokens.accessToken, CONFIG)).toBeNull();

    const flow2 = await connectFlow(user, { clientName: "Second" });
    await revokeOAuthToken(db(), {
      token: flow2.tokens.refreshToken!,
      clientId: flow2.client.clientId
    });
    expect(await resolveMcpAccess(db(), flow2.tokens.accessToken, CONFIG)).toBeNull();
  });
});

describe("per-call re-resolution", () => {
  it("rejects after the user is moved out of the bound household", async () => {
    const user = await makeUser();
    const elsewhere = await makeUser();
    const flow = await connectFlow(user);
    expect(await resolveMcpAccess(db(), flow.tokens.accessToken, CONFIG)).not.toBeNull();
    await db().update(users).set({ familyId: elsewhere.familyId }).where(eq(users.id, user.userId));
    // Never redirected to the new household: the grant dies instead.
    expect(await resolveMcpAccess(db(), flow.tokens.accessToken, CONFIG)).toBeNull();
  });

  it("rejects after the user is removed (removedAt set)", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user);
    await db().update(users).set({ removedAt: new Date() }).where(eq(users.id, user.userId));
    expect(await resolveMcpAccess(db(), flow.tokens.accessToken, CONFIG)).toBeNull();
  });

  it("rejects a token whose audience is not the canonical resource", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user);
    const raw = randomToken(32);
    await db().execute(sql`
      INSERT INTO oauth_tokens (token_hash, grant_id, kind, resource, expires_at)
      VALUES (${hashToken(raw)}, ${flow.grant.id}::uuid, 'access', 'https://meridian.test/other', now() + interval '1 hour')
    `);
    expect(await resolveMcpAccess(db(), raw, CONFIG)).toBeNull();
  });

  it("a super-admin's MCP actor is never a super-admin", async () => {
    const admin = await makeSuperAdmin();
    const flow = await connectFlow(admin);
    const access = await resolveMcpAccess(db(), flow.tokens.accessToken, CONFIG);
    expect(access!.actor.platformRole).toBe("user");
  });
});

describe("DCR registration policy", () => {
  it("rejects arbitrary internet redirect URIs; accepts first-party callbacks and loopback", async () => {
    await expectOAuthError(
      registerOAuthClient(db(), {
        clientName: "Evil",
        redirectUris: ["https://evil.example.com/callback"]
      }),
      "invalid_redirect_uri"
    );
    const ok = await registerOAuthClient(db(), {
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"]
    });
    expect(ok.client.id).toMatch(/^mcp_/);
  });

  it("confidential clients must authenticate: wrong secret fails, right secret passes", async () => {
    const { client, clientSecret } = await registerOAuthClient(db(), {
      clientName: "Confidential",
      redirectUris: [LOOPBACK],
      tokenEndpointAuthMethod: "client_secret_post"
    });
    expect(clientSecret).toBeTruthy();
    await expectOAuthError(
      authenticateOAuthClient(db(), { clientId: client.id, clientSecret: "wrong" }, CONFIG),
      "invalid_client"
    );
    const authed = await authenticateOAuthClient(
      db(),
      { clientId: client.id, clientSecret },
      CONFIG
    );
    expect(authed.clientId).toBe(client.id);
  });
});

describe("CIMD clients", () => {
  const DOC_URL = "https://clients.example.test/client.json";
  const doc = {
    client_id: DOC_URL,
    client_name: "CIMD Client",
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    token_endpoint_auth_method: "none"
  };
  const fetcher: MetadataFetcher = async (url) => {
    if (url === DOC_URL) return doc;
    throw new Error("not found");
  };

  it("resolves a client from its metadata document and validates against it", async () => {
    clearCimdCaches();
    const resolved = await resolveOAuthClient(db(), DOC_URL, fetcher);
    expect(resolved?.clientName).toBe("CIMD Client");
    const request = await validateAuthorizeRequest(
      db(),
      {
        clientId: DOC_URL,
        redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
        responseType: "code",
        codeChallenge: pkce().challenge,
        codeChallengeMethod: "S256",
        scope: "finance:read",
        resource: CONFIG.resourceUrl,
        state: null
      },
      CONFIG,
      fetcher
    );
    expect(request.client.clientId).toBe(DOC_URL);
    await expectOAuthError(
      validateAuthorizeRequest(
        db(),
        {
          clientId: DOC_URL,
          redirectUri: "https://chatgpt.com/not-in-the-document",
          responseType: "code",
          codeChallenge: pkce().challenge,
          codeChallengeMethod: "S256",
          scope: "finance:read",
          resource: CONFIG.resourceUrl,
          state: null
        },
        CONFIG,
        fetcher
      ),
      "invalid_request"
    );
  });

  it("rejects a document whose client_id does not match its URL", async () => {
    clearCimdCaches();
    const mismatched: MetadataFetcher = async () => ({ ...doc, client_id: "https://other.test/x" });
    expect(await resolveOAuthClient(db(), DOC_URL, mismatched)).toBeNull();
  });

  it("rejects documents whose redirect_uris violate the safe-callback policy (P1-5)", async () => {
    // Before the fix these were accepted as opaque strings: an exact
    // match in redirectUriAllowed would have let a javascript: URI
    // through authorize validation and into the browser redirect.
    const badUris = [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "https://user:pass@chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector_platform_oauth_redirect#fragment",
      "https://evil.example.com/callback",
      "http://localhost.evil.example.com/callback",
      "not a url"
    ];
    for (const [i, bad] of badUris.entries()) {
      clearCimdCaches();
      const url = `https://clients.example.test/bad-${i}.json`;
      const badFetcher: MetadataFetcher = async () => ({
        client_id: url,
        client_name: "Bad Redirect Client",
        redirect_uris: [bad],
        token_endpoint_auth_method: "none"
      });
      expect(
        await resolveOAuthClient(db(), url, badFetcher),
        `redirect_uri ${bad} must be rejected`
      ).toBeNull();
    }
  });

  it("passes the operator allowlist through to the metadata fetcher (P1-4 plumbing)", async () => {
    clearCimdCaches();
    const seenOpts: unknown[] = [];
    const recording: MetadataFetcher = async (_url, opts) => {
      seenOpts.push(opts);
      return doc;
    };
    const resolved = await resolveOAuthClient(db(), DOC_URL, recording, ["https://a.test/x"]);
    expect(resolved).not.toBeNull();
    expect(seenOpts).toEqual([{ allowlist: ["https://a.test/x"] }]);
  });

  it("verifies private_key_jwt assertions against the document's own JWKS", async () => {
    clearCimdCaches();
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key-1";
    const jwtDoc = {
      client_id: DOC_URL,
      client_name: "JWT Client",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      token_endpoint_auth_method: "private_key_jwt",
      jwks: { keys: [jwk] }
    };
    const jwtFetcher: MetadataFetcher = async () => jwtDoc;
    const resolved = await resolveOAuthClient(db(), DOC_URL, jwtFetcher);
    expect(resolved?.authMethod).toBe("private_key_jwt");

    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(DOC_URL)
      .setSubject(DOC_URL)
      .setAudience("https://meridian.test/oauth/token")
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti(randomToken(16))
      .sign(privateKey);
    const authed = await authenticateOAuthClient(
      db(),
      {
        clientId: DOC_URL,
        clientAssertion: assertion,
        clientAssertionType: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
      },
      CONFIG,
      jwtFetcher
    );
    expect(authed.clientId).toBe(DOC_URL);

    const { privateKey: wrongKey } = await generateKeyPair("RS256");
    const badAssertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(DOC_URL)
      .setSubject(DOC_URL)
      .setAudience("https://meridian.test/oauth/token")
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti(randomToken(16))
      .sign(wrongKey);
    await expectOAuthError(
      authenticateOAuthClient(
        db(),
        {
          clientId: DOC_URL,
          clientAssertion: badAssertion,
          clientAssertionType: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
        },
        CONFIG,
        jwtFetcher
      ),
      "invalid_client"
    );
  });

  it("requires exp/iat/jti, caps assertion lifetime, and claims each jti once (P2-6)", async () => {
    clearCimdCaches();
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "claims-key";
    const claimsDoc = {
      client_id: DOC_URL,
      client_name: "Claims Client",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      token_endpoint_auth_method: "private_key_jwt",
      jwks: { keys: [jwk] }
    };
    const claimsFetcher: MetadataFetcher = async () => claimsDoc;
    const resolved = await resolveOAuthClient(db(), DOC_URL, claimsFetcher);
    expect(resolved?.authMethod).toBe("private_key_jwt");

    const now = Math.floor(Date.now() / 1000);
    async function sign(opts: { iat?: number; exp?: number; jti?: string }): Promise<string> {
      const jwt = new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "claims-key" })
        .setIssuer(DOC_URL)
        .setSubject(DOC_URL)
        .setAudience("https://meridian.test/oauth/token");
      if (opts.iat !== undefined) jwt.setIssuedAt(opts.iat);
      if (opts.exp !== undefined) jwt.setExpirationTime(opts.exp);
      if (opts.jti !== undefined) jwt.setJti(opts.jti);
      return jwt.sign(privateKey);
    }
    const attempt = (assertion: string) =>
      authenticateOAuthClient(
        db(),
        {
          clientId: DOC_URL,
          clientAssertion: assertion,
          clientAssertionType: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
        },
        CONFIG,
        claimsFetcher
      );

    // RFC 7523 §3: exp is REQUIRED — jose alone validates it only when
    // present, so an exp-less assertion used to verify cleanly.
    await expectOAuthError(attempt(await sign({ iat: now, jti: "no-exp" })), "invalid_client");
    await expectOAuthError(
      attempt(await sign({ exp: now + 120, jti: "no-iat" })),
      "invalid_client"
    );
    await expectOAuthError(attempt(await sign({ iat: now, exp: now + 120 })), "invalid_client");
    // Lifetime cap: exp − iat must be ≤ 5 minutes.
    await expectOAuthError(
      attempt(await sign({ iat: now, exp: now + 600, jti: "too-long" })),
      "invalid_client"
    );
    // Expired assertions fail even with all claims present.
    await expectOAuthError(
      attempt(await sign({ iat: now - 600, exp: now - 300, jti: "expired" })),
      "invalid_client"
    );

    // A valid assertion authenticates exactly once: the SAME assertion
    // replayed is rejected, sequentially and concurrently.
    const good = await sign({ iat: now, exp: now + 120, jti: "good-once" });
    expect((await attempt(good)).clientId).toBe(DOC_URL);
    await expectOAuthError(attempt(good), "invalid_client");

    const raced = await sign({ iat: now, exp: now + 120, jti: "good-raced" });
    const results = await Promise.allSettled([attempt(raced), attempt(raced)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("SSRF metadata fetch policy", () => {
  const publicResolver = async () => ["93.184.216.34"];
  const jsonTransport =
    (body: unknown) =>
    async (): Promise<{
      status: number;
      contentType: string | null;
      location: string | null;
      body: string;
    }> => ({
      status: 200,
      contentType: "application/json",
      location: null,
      body: JSON.stringify(body)
    });

  it("rejects plain http and loopback/private IP literals without any fetch", async () => {
    let calls = 0;
    const counting = async () => {
      calls++;
      return { status: 200, contentType: "application/json", location: null, body: "{}" };
    };
    const fetchJson = createMetadataFetcher({ resolveHost: publicResolver, transport: counting });
    await expect(fetchJson("http://example.com/client.json")).rejects.toBeInstanceOf(SsrfError);
    await expect(fetchJson("https://127.0.0.1/client.json")).rejects.toBeInstanceOf(SsrfError);
    await expect(fetchJson("https://[::1]/client.json")).rejects.toBeInstanceOf(SsrfError);
    await expect(fetchJson("https://[::ffff:127.0.0.1]/client.json")).rejects.toBeInstanceOf(
      SsrfError
    );
    await expect(fetchJson("https://10.0.0.5/client.json")).rejects.toBeInstanceOf(SsrfError);
    await expect(fetchJson("https://localhost/client.json")).rejects.toBeInstanceOf(SsrfError);
    expect(calls).toBe(0);
  });

  it("rejects hostnames that resolve to private addresses", async () => {
    const fetchJson = createMetadataFetcher({
      resolveHost: async () => ["93.184.216.34", "192.168.1.10"],
      transport: jsonTransport({})
    });
    await expect(fetchJson("https://sneaky.example.com/client.json")).rejects.toBeInstanceOf(
      SsrfError
    );
  });

  it("re-validates redirect hops: a redirect to a link-local address is refused", async () => {
    const fetchJson = createMetadataFetcher({
      resolveHost: publicResolver,
      transport: async () => ({
        status: 302,
        contentType: null,
        location: "https://169.254.169.254/latest/meta-data",
        body: ""
      })
    });
    await expect(fetchJson("https://example.com/client.json")).rejects.toBeInstanceOf(SsrfError);
  });

  it("follows a validated redirect and pins the validated addresses into the transport", async () => {
    const seen: { url: string; pinned: string[] | null }[] = [];
    const fetchJson = createMetadataFetcher({
      resolveHost: publicResolver,
      transport: async (url, pinned) => {
        seen.push({ url: url.toString(), pinned });
        if (url.hostname === "example.com") {
          return {
            status: 302,
            contentType: null,
            location: "https://cdn.example.com/client.json",
            body: ""
          };
        }
        return {
          status: 200,
          contentType: "application/json",
          location: null,
          body: JSON.stringify({ ok: true })
        };
      }
    });
    await expect(fetchJson("https://example.com/client.json")).resolves.toEqual({ ok: true });
    expect(seen.length).toBe(2);
    expect(seen[0]!.pinned).toEqual(["93.184.216.34"]);
    expect(seen[1]!.pinned).toEqual(["93.184.216.34"]);
  });

  it("rejects non-JSON content types and unresolvable hosts", async () => {
    const html = createMetadataFetcher({
      resolveHost: publicResolver,
      transport: async () => ({
        status: 200,
        contentType: "text/html",
        location: null,
        body: "<html></html>"
      })
    });
    await expect(html("https://example.com/client.json")).rejects.toBeInstanceOf(SsrfError);
    const noDns = createMetadataFetcher({
      resolveHost: async () => [],
      transport: jsonTransport({})
    });
    await expect(noDns("https://missing.example.com/client.json")).rejects.toBeInstanceOf(
      SsrfError
    );
  });
});

// --- Route-level tests (config gate ON) -------------------------------------

const ENV_KEYS = ["MCP_ENABLED", "MCP_RESOURCE_URL", "MCP_ISSUER_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.MCP_ENABLED = "true";
  process.env.MCP_RESOURCE_URL = "https://meridian.test/mcp";
  process.env.MCP_ISSUER_URL = "https://meridian.test";
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function rpc(token: string | null, body: unknown) {
  const res = await mcpPost(
    new Request("https://meridian.test/mcp", {
      method: "POST",
      headers: {
        // Real HTTP requests always carry Host; a constructed Request
        // does not synthesize one, and the route's host guard reads it.
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
  return { status: res.status, headers: res.headers, body: parsed };
}

describe("/mcp route and discovery (configured)", () => {
  it("serves protected-resource metadata without offline_access, and AS metadata with it", async () => {
    const prm = prmGet();
    expect(prm.status).toBe(200);
    const prmBody = (await prm.json()) as { resource: string; scopes_supported: string[] };
    expect(prmBody.resource).toBe("https://meridian.test/mcp");
    expect(prmBody.scopes_supported).not.toContain("offline_access");

    const asRes = asMetadataGet();
    expect(asRes.status).toBe(200);
    const asBody = (await asRes.json()) as {
      issuer: string;
      token_endpoint: string;
      code_challenge_methods_supported: string[];
      scopes_supported: string[];
    };
    expect(asBody.issuer).toBe("https://meridian.test");
    expect(asBody.token_endpoint).toBe("https://meridian.test/oauth/token");
    expect(asBody.code_challenge_methods_supported).toEqual(["S256"]);
    expect(asBody.scopes_supported).toContain("offline_access");
  });

  it("rejects missing and garbage bearer tokens with a resource_metadata challenge", async () => {
    const noToken = await rpc(null, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://meridian.test/.well-known/oauth-protected-resource/mcp"'
    );
    const garbage = await rpc("not-a-token", { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(garbage.status).toBe(401);
  });

  it("answers initialize and get_financial_summary with consistent figures", async () => {
    const user = await makeUser();
    const accountId = await makeAccount(user, { openingBalanceDisplayMinor: 100_000 });
    await addTxn(user, accountId, { amountLedgerMinor: 25_000, name: "Groceries" });
    const flow = await connectFlow(user);

    const init = await rpc(flow.tokens.accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" }
      }
    });
    expect(init.status).toBe(200);
    expect(init.body).toBeTruthy();

    const call = await rpc(flow.tokens.accessToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_financial_summary", arguments: {} }
    });
    expect(call.status).toBe(200);
    const result = (call.body as { result?: { structuredContent?: Record<string, never> } })
      ?.result;
    const summary = result?.structuredContent as unknown as {
      household: { baseCurrency: string; timezone: string };
      netWorth: { amountMinor: string };
      expensesThisMonth: { amountMinor: string };
      accounts: { id: string; amountMinor: string; balanceInBaseMinor: string }[];
      fx: { complete: boolean };
    };
    expect(summary.household.baseCurrency).toBe("USD");
    expect(summary.expensesThisMonth.amountMinor).toBe("25000");
    const balance = await latestBalance(accountId);
    const account = summary.accounts.find((a) => a.id === accountId);
    expect(account?.amountMinor).toBe(String(balance!.balanceMinor));
    expect(summary.netWorth.amountMinor).toBe(account!.balanceInBaseMinor);
    expect(summary.fx.complete).toBe(true);

    // Metadata-only audit was written for the tool call.
    const audit = await db().execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM audit_events
      WHERE action = 'mcp.tool_called' AND entity_id = ${flow.grant.id}
    `);
    expect(Number(audit.rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it("enforces the finance:read scope inside the tool handler", async () => {
    const user = await makeUser();
    const flow = await connectFlow(user, { scopes: ["transactions:read"] });
    const call = await rpc(flow.tokens.accessToken, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_financial_summary", arguments: {} }
    });
    const result = (call.body as { result?: { isError?: boolean; content?: { text: string }[] } })
      ?.result;
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain("finance:read");
  });

  it("token endpoint speaks OAuth errors and rejects JSON bodies", async () => {
    const res = await tokenPost(
      new Request("https://meridian.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code" })
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("registration endpoint issues a client over HTTP", async () => {
    const res = await registerPost(
      new Request("https://meridian.test/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "HTTP Client",
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"]
        })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    expect(body.client_id).toMatch(/^mcp_/);
  });

  it("revocation endpoint returns 200 for unknown tokens", async () => {
    const form = new URLSearchParams({ token: "never-issued" });
    const res = await revokePost(
      new Request("https://meridian.test/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString()
      })
    );
    expect(res.status).toBe(200);
  });
});

// --- Config gate CLOSED (acceptance condition 5) -----------------------------

describe("config gate closed: MCP surface exposes nothing", () => {
  beforeAll(() => {
    delete process.env.MCP_ENABLED;
  });

  it("every MCP/OAuth endpoint 404s", async () => {
    expect(prmGet().status).toBe(404);
    expect(asMetadataGet().status).toBe(404);
    const mcp = await rpc(null, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(mcp.status).toBe(404);
    const token = await tokenPost(
      new Request("https://meridian.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code"
      })
    );
    expect(token.status).toBe(404);
    const register = await registerPost(
      new Request("https://meridian.test/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [LOOPBACK] })
      })
    );
    expect(register.status).toBe(404);
    const revoke = await revokePost(
      new Request("https://meridian.test/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=x"
      })
    );
    expect(revoke.status).toBe(404);
  });
});
