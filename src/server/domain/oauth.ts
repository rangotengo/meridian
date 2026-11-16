/**
 * Purpose-built OAuth 2.1 authorization server for read-only MCP access
 * (design: docs/mcp-poc.md). Meridian's existing session login stays the
 * login of record: this module never authenticates users — it issues and
 * verifies the grants, codes, and opaque tokens that the consent flow
 * (backed by that login) produces.
 *
 * Security invariants enforced here:
 *  - PKCE S256 only; codes are single-use via an ATOMIC conditional
 *    consume on both backends, and presenting an already-used code
 *    invalidates the whole token family (OAuth 2.1 BCP replay defense).
 *  - Family invalidation is a PERSISTENT marker
 *    (oauth_authorization_codes.invalidated_at) plus a grant revocation,
 *    applied in one transaction. Token verification checks the marker,
 *    and every issuance path re-checks it while holding a row lock on
 *    the code (Postgres SELECT … FOR UPDATE; the cloud executor's
 *    serialized transactions provide the equivalent), so an in-flight
 *    issuer can never publish credentials after invalidation — there is
 *    no settle window and no sweep race.
 *  - Refresh tokens rotate on every use; presenting an already-rotated or
 *    revoked refresh token invalidates the whole token family.
 *  - A code/token only ever serves the resource it was STORED with: if
 *    the configured canonical resource changes, stored credentials are
 *    rejected at exchange/refresh and the client must reconnect.
 *  - Tokens are opaque and hash-stored; verification is a live database
 *    read, so revocation takes effect on the very next call.
 *  - Every grant is bound to user + client + ONE household. Access
 *    resolution re-reads the user's CURRENT state per call: a removed
 *    user, or a user whose household no longer matches the grant's bound
 *    household, is rejected — never silently redirected to another
 *    household.
 *  - MCP actors always get platformRole "user" (API-key precedent): no
 *    agent connection can reach platform-admin functionality.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, notExists } from "drizzle-orm";
import type { Executor } from "../db/client";
import { usesCloudStorage } from "../db/dialect";
import {
  accounts,
  auditEvents,
  families,
  oauthAssertionClaims,
  oauthAuthorizationCodes,
  oauthAuthorizationRequests,
  oauthClients,
  oauthGrants,
  oauthTokens,
  users
} from "../db/schema";
import type { Actor, Family } from "../auth/context";
import { accessibleAccountIds } from "../authorization/access";
import { hashToken, randomToken } from "@/lib/crypto";
import { recordAudit } from "../observability/audit";
import type { McpConfig } from "@/lib/env";
import { MCP_ALL_SCOPES, MCP_DEFAULT_SCOPES } from "../mcp/scopes";
import {
  fetchCimdDocument,
  isCimdClientId,
  oauthRedirectUriAllowed,
  redirectUriAllowed,
  verifyClientAssertion,
  type CimdDocument
} from "../mcp/cimd";
import type { MetadataFetcher } from "../mcp/ssrf";

export class OAuthError extends Error {
  readonly error: string;
  readonly status: number;
  constructor(error: string, description: string, status = 400) {
    super(description);
    this.name = "OAuthError";
    this.error = error;
    this.status = status;
  }
}

export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type OAuthGrantRow = typeof oauthGrants.$inferSelect;

export type ResolvedClient = {
  clientId: string;
  clientName: string;
  authMethod: string;
  redirectUris: string[];
  /** DCR secret hash; null for public and CIMD clients. */
  secretHash: string | null;
  cimd: CimdDocument | null;
};

// --- Client registration (DCR, RFC 7591) -----------------------------------

const DCR_AUTH_METHODS = ["none", "client_secret_basic", "client_secret_post"] as const;

/**
 * Redirect-URI policy for DCR in this release — the shared safe-callback
 * policy (see oauthRedirectUriAllowed in ../mcp/cimd): registration is
 * limited to the two first-party AI clients' HTTPS callbacks and to
 * loopback (native apps / Claude Code, RFC 8252). Arbitrary internet
 * clients cannot self-register.
 */
export function dcrRedirectUriAllowed(uri: string): boolean {
  return oauthRedirectUriAllowed(uri);
}

export async function registerOAuthClient(
  exec: Executor,
  input: {
    clientName?: string;
    redirectUris: string[];
    tokenEndpointAuthMethod?: string;
  }
): Promise<{ client: OAuthClientRow; clientSecret: string | null }> {
  const redirectUris = [...new Set(input.redirectUris ?? [])];
  if (redirectUris.length === 0 || redirectUris.length > 10) {
    throw new OAuthError("invalid_redirect_uri", "Provide between 1 and 10 redirect URIs.");
  }
  for (const uri of redirectUris) {
    if (!dcrRedirectUriAllowed(uri)) {
      throw new OAuthError(
        "invalid_redirect_uri",
        "Redirect URIs are limited to claude.ai / chatgpt.com HTTPS callbacks and loopback HTTP."
      );
    }
  }
  const authMethod = input.tokenEndpointAuthMethod ?? "none";
  if (!(DCR_AUTH_METHODS as readonly string[]).includes(authMethod)) {
    throw new OAuthError(
      "invalid_client_metadata",
      "token_endpoint_auth_method must be one of: none, client_secret_basic, client_secret_post."
    );
  }
  const clientSecret = authMethod === "none" ? null : randomToken(32);
  const [client] = await exec
    .insert(oauthClients)
    .values({
      id: `mcp_${randomToken(18)}`,
      clientName: (input.clientName ?? "Unnamed client").slice(0, 120),
      redirectUris,
      tokenEndpointAuthMethod: authMethod,
      secretHash: clientSecret ? hashToken(clientSecret) : null
    })
    .returning();
  return { client: client!, clientSecret };
}

export async function resolveOAuthClient(
  exec: Executor,
  clientId: string,
  fetcher?: MetadataFetcher,
  cimdAllowlist?: string[]
): Promise<ResolvedClient | null> {
  if (isCimdClientId(clientId)) {
    let doc: CimdDocument;
    try {
      doc = await fetchCimdDocument(clientId, fetcher, cimdAllowlist);
    } catch {
      // Fetch/validation failures are indistinguishable from an unknown
      // client to the caller; details stay server-side.
      return null;
    }
    return {
      clientId: doc.clientId,
      clientName: doc.clientName,
      authMethod: doc.tokenEndpointAuthMethod,
      redirectUris: doc.redirectUris,
      secretHash: null,
      cimd: doc
    };
  }
  const [row] = await exec
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, clientId))
    .limit(1);
  if (!row) return null;
  return {
    clientId: row.id,
    clientName: row.clientName,
    authMethod: row.tokenEndpointAuthMethod,
    redirectUris: row.redirectUris,
    secretHash: row.secretHash,
    cimd: null
  };
}

// --- Authorization request validation + consent ----------------------------

export type AuthorizeRequest = {
  client: ResolvedClient;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  state: string | null;
  resource: string;
};

export async function validateAuthorizeRequest(
  exec: Executor,
  params: {
    clientId?: string | null;
    redirectUri?: string | null;
    responseType?: string | null;
    codeChallenge?: string | null;
    codeChallengeMethod?: string | null;
    scope?: string | null;
    resource?: string | null;
    state?: string | null;
  },
  config: McpConfig,
  fetcher?: MetadataFetcher
): Promise<AuthorizeRequest> {
  if (!params.clientId) throw new OAuthError("invalid_request", "Missing client_id.");
  const client = await resolveOAuthClient(exec, params.clientId, fetcher, config.cimdAllowlist);
  if (!client) throw new OAuthError("invalid_client", "Unknown or unverifiable client.", 401);

  if (!params.redirectUri) throw new OAuthError("invalid_request", "Missing redirect_uri.");
  if (!redirectUriAllowed(client.redirectUris, params.redirectUri)) {
    throw new OAuthError(
      "invalid_request",
      "redirect_uri does not match the client's registered URIs."
    );
  }

  if (params.responseType !== "code") {
    throw new OAuthError("unsupported_response_type", "Only response_type=code is supported.");
  }

  // PKCE is mandatory and S256-only: an absent method defaults to "plain"
  // per RFC 7636, which is a downgrade and rejected like an explicit one.
  if (!params.codeChallenge) {
    throw new OAuthError("invalid_request", "Missing code_challenge (PKCE is required).");
  }
  if (params.codeChallengeMethod !== "S256") {
    throw new OAuthError("invalid_request", "code_challenge_method must be S256.");
  }
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(params.codeChallenge)) {
    throw new OAuthError("invalid_request", "code_challenge is malformed.");
  }

  if (params.resource && params.resource !== config.resourceUrl) {
    throw new OAuthError(
      "invalid_target",
      "The requested resource does not match this server's canonical MCP resource."
    );
  }

  const requested = params.scope ? params.scope.split(/\s+/).filter(Boolean) : [];
  for (const scope of requested) {
    if (!(MCP_ALL_SCOPES as readonly string[]).includes(scope)) {
      throw new OAuthError("invalid_scope", `Unknown scope: ${scope}`);
    }
  }
  const scopes = requested.length > 0 ? [...new Set(requested)] : [...MCP_DEFAULT_SCOPES];

  return {
    client,
    redirectUri: params.redirectUri,
    scopes,
    codeChallenge: params.codeChallenge,
    state: params.state ?? null,
    resource: config.resourceUrl
  };
}

export type OAuthAuthorizationRequestRow = typeof oauthAuthorizationRequests.$inferSelect;

/** Consent records live for ten minutes — long enough to read the page,
 * short enough that a stale tab cannot be approved later. */
const AUTHORIZATION_REQUEST_TTL_SECONDS = 600;

/**
 * Persist the validated authorization request server-side. The consent
 * page renders from this record and the decision actions consume it —
 * form fields are never trusted for client, redirect_uri, scopes,
 * resource, code challenge, or household.
 */
export async function createAuthorizationRequest(
  exec: Executor,
  input: { actor: Actor; request: AuthorizeRequest }
): Promise<{ record: OAuthAuthorizationRequestRow; csrfToken: string }> {
  const { actor, request } = input;
  const csrfToken = randomToken(32);
  const [record] = await exec
    .insert(oauthAuthorizationRequests)
    .values({
      userId: actor.userId,
      familyId: actor.familyId,
      sessionId: actor.sessionId,
      clientId: request.client.clientId,
      clientName: request.client.clientName,
      redirectUri: request.redirectUri,
      scopes: request.scopes,
      resource: request.resource,
      codeChallenge: request.codeChallenge,
      state: request.state,
      csrfTokenHash: hashToken(csrfToken),
      expiresAt: new Date(Date.now() + AUTHORIZATION_REQUEST_TTL_SECONDS * 1000)
    })
    .returning();
  return { record: record!, csrfToken };
}

/**
 * Validate and atomically consume a consent record for a decision
 * (approve or deny). Every binding is checked: the record must belong to
 * this user AND this session, carry the CSRF token issued with it, name
 * the household the actor is still in, and be unconsumed and unexpired.
 * Consumption is a conditional UPDATE, so a record can be decided
 * exactly once even under concurrent submissions.
 */
export async function consumeAuthorizationRequest(
  exec: Executor,
  input: { requestId: string; actor: Actor; csrfToken: string | null }
): Promise<OAuthAuthorizationRequestRow> {
  const fail = () =>
    new OAuthError(
      "invalid_request",
      "This connection request is no longer valid. Start the connection again from your AI assistant."
    );
  const [record] = await exec
    .select()
    .from(oauthAuthorizationRequests)
    .where(eq(oauthAuthorizationRequests.id, input.requestId))
    .limit(1);
  if (!record) throw fail();
  if (record.userId !== input.actor.userId) throw fail();
  if (record.sessionId !== input.actor.sessionId) throw fail();
  if (record.familyId !== input.actor.familyId) throw fail();
  if (!input.csrfToken || hashToken(input.csrfToken) !== record.csrfTokenHash) throw fail();
  if (record.consumedAt || record.expiresAt <= new Date()) throw fail();

  const consumed = await exec
    .update(oauthAuthorizationRequests)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthAuthorizationRequests.id, record.id),
        isNull(oauthAuthorizationRequests.consumedAt)
      )
    )
    .returning({ id: oauthAuthorizationRequests.id });
  if (consumed.length === 0) throw fail();
  return record;
}

/**
 * Resolve the consent page's account selection into the grant's stored
 * account ceiling. The selection arrives from the form, so it is never
 * trusted: every id must be an account the consenting user can access
 * RIGHT NOW in the household the record is bound to (the caller has
 * already consumed the record, which guarantees record.familyId ===
 * actor.familyId). Fail closed: an empty selection or ANY inaccessible
 * id rejects the whole approval and no grant is minted. A selection
 * covering every accessible account is stored as an empty ceiling —
 * "all accounts", re-resolved per call, never a snapshot of rights.
 */
async function resolveConsentAccountCeiling(
  exec: Executor,
  actor: Actor,
  selected: string[]
): Promise<string[]> {
  const fail = () =>
    new OAuthError(
      "invalid_request",
      "The account selection for this connection is no longer valid. Start the connection again from your AI assistant."
    );
  const unique = [...new Set(selected)];
  if (unique.length === 0) throw fail();
  const accessible = await accessibleAccountIds(exec, actor);
  const accessibleSet = new Set(accessible);
  if (unique.some((id) => !accessibleSet.has(id))) throw fail();
  if (unique.length === accessible.length) return [];
  // Store in accessible-list order so the ceiling is deterministic.
  return accessible.filter((id) => unique.includes(id));
}

/**
 * Approval: mint a NEW durable grant from the consumed record (every
 * connection is its own grant row — reconnecting never revives or
 * extends an earlier grant) plus a single-use authorization code.
 *
 * `consent` carries the consent page's CHOICES (never request data):
 * - `accountIds`: the account picker's selection. When omitted (the
 *   picker was not offered, or programmatic approvals), the grant gets
 *   the default empty ceiling — all accounts the user can access. When
 *   present, the ids are validated by resolveConsentAccountCeiling
 *   before anything is stored.
 * - `ssisAccess`: the SSIS opt-in checkbox. Defaults to false — the
 *   permission is never granted implicitly, and finance:read does not
 *   cover the SSIS dataset.
 */
export async function approveAuthorizationRequest(
  exec: Executor,
  record: OAuthAuthorizationRequestRow,
  config: McpConfig,
  consent?: { actor: Actor; accountIds?: string[]; ssisAccess?: boolean }
): Promise<{ grant: OAuthGrantRow; code: string }> {
  const accountIds =
    consent?.accountIds !== undefined
      ? await resolveConsentAccountCeiling(exec, consent.actor, consent.accountIds)
      : [];
  const ssisAccess = consent?.ssisAccess === true;
  const now = new Date();
  const [grant] = await exec
    .insert(oauthGrants)
    .values({
      userId: record.userId,
      familyId: record.familyId,
      clientId: record.clientId,
      clientName: record.clientName,
      scopes: record.scopes,
      accountIds,
      ssisAccess,
      status: "active",
      expiresAt: new Date(now.getTime() + config.grantTtlSeconds * 1000)
    })
    .returning();
  const created = grant!;
  await recordAudit(exec, {
    familyId: record.familyId,
    actorUserId: record.userId,
    action: "oauth_grant.created",
    entityType: "oauth_grant",
    entityId: created.id,
    metadata: { clientId: record.clientId, scopes: record.scopes, accountIds, ssisAccess }
  });

  const code = randomToken(32);
  await exec.insert(oauthAuthorizationCodes).values({
    codeHash: hashToken(code),
    grantId: created.id,
    clientId: record.clientId,
    redirectUri: record.redirectUri,
    resource: record.resource,
    codeChallenge: record.codeChallenge,
    expiresAt: new Date(now.getTime() + config.authorizationCodeTtlSeconds * 1000)
  });
  return { grant: created, code };
}

// --- Token endpoint ----------------------------------------------------------

export type ClientAuthInput = {
  clientId?: string | null;
  clientSecret?: string | null;
  clientAssertion?: string | null;
  clientAssertionType?: string | null;
};

export async function authenticateOAuthClient(
  exec: Executor,
  auth: ClientAuthInput,
  config: McpConfig,
  fetcher?: MetadataFetcher
): Promise<ResolvedClient> {
  if (!auth.clientId) throw new OAuthError("invalid_client", "Missing client_id.", 401);
  const client = await resolveOAuthClient(exec, auth.clientId, fetcher, config.cimdAllowlist);
  if (!client) throw new OAuthError("invalid_client", "Unknown client.", 401);

  if (client.authMethod === "none") {
    return client;
  }
  if (client.authMethod === "client_secret_basic" || client.authMethod === "client_secret_post") {
    if (
      !auth.clientSecret ||
      !client.secretHash ||
      hashToken(auth.clientSecret) !== client.secretHash
    ) {
      throw new OAuthError("invalid_client", "Client authentication failed.", 401);
    }
    return client;
  }
  if (client.authMethod === "private_key_jwt") {
    if (
      !client.cimd ||
      auth.clientAssertionType !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" ||
      !auth.clientAssertion
    ) {
      throw new OAuthError("invalid_client", "A client assertion is required.", 401);
    }
    let verified: { jti: string; expiresAt: Date };
    try {
      verified = await verifyClientAssertion(
        client.cimd,
        auth.clientAssertion,
        `${config.issuerUrl}/oauth/token`,
        fetcher,
        config.cimdAllowlist
      );
    } catch {
      throw new OAuthError("invalid_client", "Client assertion verification failed.", 401);
    }
    // Replay protection (RFC 7523 §3): the assertion's jti is claimed
    // atomically only AFTER its signature and claims verify, so a
    // captured assertion — even replayed concurrently — authenticates
    // at most once.
    const claimed = await claimAssertionJti(
      exec,
      client.clientId,
      verified.jti,
      verified.expiresAt
    );
    if (!claimed) {
      throw new OAuthError("invalid_client", "Client assertion was already used.", 401);
    }
    return client;
  }
  throw new OAuthError("invalid_client", "Unsupported client authentication method.", 401);
}

/**
 * Atomically claim a verified assertion's (client_id, jti) pair until
 * the end of its acceptance window (expiry plus clock tolerance).
 * The insert races on the table's primary key,
 * so exactly one of any number of concurrent claims succeeds. Expired
 * claims for the same client are pruned opportunistically.
 */
async function claimAssertionJti(
  exec: Executor,
  clientId: string,
  jti: string,
  expiresAt: Date
): Promise<boolean> {
  await exec
    .delete(oauthAssertionClaims)
    .where(
      and(
        eq(oauthAssertionClaims.clientId, clientId),
        lt(oauthAssertionClaims.expiresAt, new Date())
      )
    );
  const claimed = await exec
    .insert(oauthAssertionClaims)
    .values({ clientId, jti, expiresAt })
    .onConflictDoNothing()
    .returning({ jti: oauthAssertionClaims.jti });
  return claimed.length > 0;
}

export type TokenSuccess = {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  refreshToken?: string;
  scope: string;
};

async function issueTokenPair(
  exec: Executor,
  grant: OAuthGrantRow,
  codeId: string | null,
  config: McpConfig,
  /** The audience the family was STORED with at consent time. Callers
   * verify it still equals the configured canonical resource before
   * issuing; rotation preserves it verbatim rather than silently
   * retargeting credentials to a new resource. */
  resource: string
): Promise<{ pair: TokenSuccess; refreshTokenId: string | null }> {
  const now = Date.now();
  const accessToken = randomToken(32);
  await exec.insert(oauthTokens).values({
    tokenHash: hashToken(accessToken),
    grantId: grant.id,
    codeId,
    kind: "access",
    resource,
    expiresAt: new Date(now + config.accessTokenTtlSeconds * 1000)
  });
  const pair: TokenSuccess = {
    accessToken,
    tokenType: "Bearer",
    expiresIn: config.accessTokenTtlSeconds,
    scope: grant.scopes.join(" ")
  };
  let refreshTokenId: string | null = null;
  if (grant.scopes.includes("offline_access")) {
    const refreshToken = randomToken(32);
    const [inserted] = await exec
      .insert(oauthTokens)
      .values({
        tokenHash: hashToken(refreshToken),
        grantId: grant.id,
        codeId,
        kind: "refresh",
        resource,
        expiresAt: new Date(now + config.refreshTokenTtlSeconds * 1000)
      })
      .returning({ id: oauthTokens.id });
    refreshTokenId = inserted?.id ?? null;
    pair.refreshToken = refreshToken;
  }
  return { pair, refreshTokenId };
}

/**
 * Family invalidation — the durable replay/reuse response.
 *
 * One transaction: (1) stamp the family root's invalidated_at marker,
 * (2) revoke the grant, (3) revoke every currently-visible family
 * token. The marker is the load-bearing part: token verification
 * (resolveMcpAccess) rejects any token whose family is invalidated,
 * and every issuance path re-checks the marker while holding the code
 * row's lock, so a token inserted AFTER this sweep — by an issuer that
 * was in flight when invalidation began — is still dead on arrival,
 * and an issuer that starts after invalidation aborts before
 * inserting. Lock ordering is always code row → grant row → token
 * rows, matching the issuance paths, so invalidation and issuance
 * serialize instead of deadlocking.
 */
async function applyFamilyInvalidation(
  exec: Executor,
  codeId: string | null,
  grantId: string
): Promise<void> {
  const now = new Date();
  if (codeId) {
    await exec
      .update(oauthAuthorizationCodes)
      .set({ invalidatedAt: now })
      .where(
        and(eq(oauthAuthorizationCodes.id, codeId), isNull(oauthAuthorizationCodes.invalidatedAt))
      );
  }
  await exec
    .update(oauthGrants)
    .set({ status: "revoked", revokedAt: now, updatedAt: now })
    .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.status, "active")));
  if (codeId) {
    await exec
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.codeId, codeId), isNull(oauthTokens.revokedAt)));
  } else {
    await exec
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)));
  }
}

async function invalidateTokenFamily(
  exec: Executor,
  codeId: string | null,
  grantId: string
): Promise<void> {
  await exec.transaction(async (tx) => {
    await applyFamilyInvalidation(tx as Executor, codeId, grantId);
  });
}

/**
 * Row-locking reads for the issuance paths. On Postgres these are
 * SELECT … FOR UPDATE: the lock is held until the issuance transaction
 * commits, which is what forces a concurrent family invalidation to
 * either commit entirely before issuance (the issuer then sees the
 * marker and aborts) or wait until issuance has committed (its sweep
 * then revokes the new tokens, and verification rejects them via the
 * marker regardless). On the cloud backend the executor serializes
 * whole transactions behind its mutex, so a plain read inside the
 * transaction is already atomic with respect to other transactions —
 * the FOR UPDATE clause is neither available nor needed there.
 */
async function lockCodeRow(tx: Executor, codeId: string) {
  const query = tx
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.id, codeId))
    .limit(1);
  const rows = usesCloudStorage ? await query : await query.for("update");
  return rows[0] ?? null;
}

async function lockGrantRow(tx: Executor, grantId: string) {
  const query = tx.select().from(oauthGrants).where(eq(oauthGrants.id, grantId)).limit(1);
  const rows = usesCloudStorage ? await query : await query.for("update");
  return rows[0] ?? null;
}

async function lockTokenRow(tx: Executor, tokenId: string) {
  const query = tx.select().from(oauthTokens).where(eq(oauthTokens.id, tokenId)).limit(1);
  const rows = usesCloudStorage ? await query : await query.for("update");
  return rows[0] ?? null;
}

function pkceChallengeMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return computed === challenge;
}

export async function exchangeAuthorizationCode(
  exec: Executor,
  input: {
    code?: string | null;
    redirectUri?: string | null;
    codeVerifier?: string | null;
    resource?: string | null;
  },
  client: ResolvedClient,
  config: McpConfig
): Promise<TokenSuccess> {
  if (!input.code) throw new OAuthError("invalid_request", "Missing code.");
  const [codeRow] = await exec
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, hashToken(input.code)))
    .limit(1);
  if (!codeRow) throw new OAuthError("invalid_grant", "Unknown authorization code.");
  if (codeRow.clientId !== client.clientId) {
    throw new OAuthError("invalid_grant", "The code was issued to a different client.");
  }

  if (codeRow.usedAt) {
    // Replay of a consumed code: durably invalidate the whole family.
    // No settle window — the invalidation marker makes any in-flight
    // or future issuance from this code dead on arrival.
    await invalidateTokenFamily(exec, codeRow.id, codeRow.grantId);
    throw new OAuthError("invalid_grant", "Authorization code was already used.");
  }
  if (codeRow.expiresAt <= new Date()) {
    throw new OAuthError("invalid_grant", "Authorization code expired.");
  }

  // Atomic single-use consume: exactly one exchanger can flip used_at,
  // on Postgres (conditional UPDATE) and on the cloud executor
  // (serialized Durable Object storage) alike.
  const consumed = await exec
    .update(oauthAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthAuthorizationCodes.id, codeRow.id), isNull(oauthAuthorizationCodes.usedAt)))
    .returning({ id: oauthAuthorizationCodes.id });
  if (consumed.length === 0) {
    await invalidateTokenFamily(exec, codeRow.id, codeRow.grantId);
    throw new OAuthError("invalid_grant", "Authorization code was already used.");
  }

  // This call won the consume; the code is spent from here on and any
  // failure below issues nothing.
  if (!input.redirectUri || input.redirectUri !== codeRow.redirectUri) {
    throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request.");
  }
  // The STORED audience governs (RFC 8707): a code minted under a
  // different canonical resource than the current configuration can
  // never be exchanged — the connection must be re-consented under the
  // new resource. Comparing only the request parameter would let a
  // config change silently retarget the credential.
  if (codeRow.resource !== config.resourceUrl) {
    throw new OAuthError(
      "invalid_grant",
      "The authorization code was issued for a different resource. Reconnect the client."
    );
  }
  if (input.resource && input.resource !== config.resourceUrl) {
    throw new OAuthError("invalid_target", "Resource does not match the canonical MCP resource.");
  }
  if (!input.codeVerifier || !pkceChallengeMatches(input.codeVerifier, codeRow.codeChallenge)) {
    throw new OAuthError("invalid_grant", "PKCE verification failed.");
  }

  // Issuance runs in one transaction that re-checks the family marker
  // and the grant under row locks: if a replay/revocation invalidated
  // the family at any point up to now, this aborts; if invalidation
  // comes later, it revokes these tokens and verification rejects them
  // via the marker. There is no interleaving that leaves usable
  // credentials behind.
  return exec.transaction(async (tx) => {
    const lockedCode = await lockCodeRow(tx as Executor, codeRow.id);
    if (!lockedCode || lockedCode.invalidatedAt) {
      throw new OAuthError("invalid_grant", "Authorization code was already used.");
    }
    const grant = await lockGrantRow(tx as Executor, codeRow.grantId);
    if (!grant || grant.status !== "active" || grant.expiresAt <= new Date()) {
      throw new OAuthError("invalid_grant", "The underlying grant is no longer active.");
    }
    const { pair } = await issueTokenPair(
      tx as Executor,
      grant,
      codeRow.id,
      config,
      codeRow.resource
    );
    await tx
      .update(oauthAuthorizationCodes)
      .set({ issuedAt: new Date() })
      .where(eq(oauthAuthorizationCodes.id, codeRow.id));
    return pair;
  });
}

export async function refreshOAuthToken(
  exec: Executor,
  input: { refreshToken?: string | null; resource?: string | null },
  client: ResolvedClient,
  config: McpConfig
): Promise<TokenSuccess> {
  if (!input.refreshToken) throw new OAuthError("invalid_request", "Missing refresh_token.");
  const [peek] = await exec
    .select({ id: oauthTokens.id, grantId: oauthTokens.grantId, codeId: oauthTokens.codeId })
    .from(oauthTokens)
    .where(
      and(eq(oauthTokens.tokenHash, hashToken(input.refreshToken)), eq(oauthTokens.kind, "refresh"))
    )
    .limit(1);
  if (!peek) throw new OAuthError("invalid_grant", "Unknown refresh token.");
  if (input.resource && input.resource !== config.resourceUrl) {
    throw new OAuthError("invalid_target", "Resource does not match the canonical MCP resource.");
  }

  // Rotation runs in ONE transaction under row locks (code → grant →
  // token, the same order as family invalidation). Every state check is
  // re-done against the locked rows, so a concurrent rotation,
  // revocation, or invalidation cannot interleave: exactly one rotation
  // wins, and a loser that detects reuse invalidates the family INSIDE
  // its transaction (the invalidation commits; the error is thrown only
  // after the transaction returns, so it is never rolled back).
  type Outcome = { pair: TokenSuccess } | { reuse: true } | { error: OAuthError };
  const outcome: Outcome = await exec.transaction(async (tx) => {
    const execTx = tx as Executor;
    if (peek.codeId) {
      const code = await lockCodeRow(execTx, peek.codeId);
      if (!code) return { error: new OAuthError("invalid_grant", "Unknown refresh token.") };
      if (code.invalidatedAt) {
        return {
          error: new OAuthError(
            "invalid_grant",
            "Refresh token reuse detected; the grant was revoked."
          )
        };
      }
    }
    const grant = await lockGrantRow(execTx, peek.grantId);
    if (!grant || grant.clientId !== client.clientId) {
      return {
        error: new OAuthError("invalid_grant", "The refresh token belongs to a different client.")
      };
    }
    const row = await lockTokenRow(execTx, peek.id);
    if (!row) return { error: new OAuthError("invalid_grant", "Unknown refresh token.") };

    if (row.revokedAt || row.replacedById) {
      // Reuse of a rotated-out or revoked refresh token: treat as theft
      // and invalidate the entire token family (OAuth 2.1 §4.3.1) —
      // including any descendant pair a concurrent rotation just minted.
      await applyFamilyInvalidation(execTx, row.codeId, row.grantId);
      return { reuse: true };
    }
    if (row.expiresAt <= new Date()) {
      return { error: new OAuthError("invalid_grant", "Refresh token expired.") };
    }
    if (grant.status !== "active" || grant.expiresAt <= new Date()) {
      return {
        error: new OAuthError("invalid_grant", "The underlying grant is no longer active.")
      };
    }
    // The STORED audience governs: a refresh token minted under a
    // different canonical resource than the current configuration must
    // not mint credentials for the new resource. Rotation preserves
    // the original audience; a resource change requires fresh consent.
    if (row.resource !== config.resourceUrl) {
      return {
        error: new OAuthError(
          "invalid_grant",
          "The refresh token was issued for a different resource. Reconnect the client."
        )
      };
    }

    const { pair, refreshTokenId } = await issueTokenPair(
      execTx,
      grant,
      row.codeId,
      config,
      row.resource
    );
    const marked = await execTx
      .update(oauthTokens)
      .set({ replacedById: refreshTokenId })
      .where(
        and(
          eq(oauthTokens.id, row.id),
          isNull(oauthTokens.replacedById),
          isNull(oauthTokens.revokedAt)
        )
      )
      .returning({ id: oauthTokens.id });
    if (marked.length === 0) {
      // Unreachable while the row lock is held; kept as a fail-closed
      // guard so a lost rotation race can never leave two live pairs.
      await applyFamilyInvalidation(execTx, row.codeId, row.grantId);
      return { reuse: true };
    }
    return { pair };
  });

  if ("reuse" in outcome) {
    throw new OAuthError("invalid_grant", "Refresh token reuse detected; the grant was revoked.");
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.pair;
}

/** RFC 7009 revocation. Unknown tokens and other clients' tokens are a
 * silent success — the endpoint never confirms a token's existence. */
export async function revokeOAuthToken(
  exec: Executor,
  input: { token?: string | null; clientId?: string | null }
): Promise<void> {
  if (!input.token) return;
  const [row] = await exec
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.tokenHash, hashToken(input.token)))
    .limit(1);
  if (!row) return;
  if (input.clientId) {
    const [grant] = await exec
      .select()
      .from(oauthGrants)
      .where(eq(oauthGrants.id, row.grantId))
      .limit(1);
    if (!grant || grant.clientId !== input.clientId) return;
  }
  if (row.kind === "refresh") {
    await invalidateTokenFamily(exec, row.codeId, row.grantId);
  } else if (!row.revokedAt) {
    await exec.update(oauthTokens).set({ revokedAt: new Date() }).where(eq(oauthTokens.id, row.id));
  }
}

// --- Housekeeping (nightly cleanup job) --------------------------------------

export type OAuthHousekeepingResult = {
  assertionClaimsDeleted: number;
  authorizationRequestsDeleted: number;
  staleClientsDeleted: number;
};

/**
 * Bounds OAuth state growth (wired into the nightly maintenance:cleanup
 * job):
 *  - expired private_key_jwt assertion claims (they are meaningless
 *    once the assertion's clock-tolerant acceptance window has closed);
 *  - authorization-request records a day past expiry (consent records
 *    live ten minutes; the extra day is audit slack);
 *  - DCR client registrations older than 30 days that never produced a
 *    grant — abandoned registrations from clients that connected once
 *    and never finished, or never tried again.
 * Codes and tokens are deliberately NOT pruned here: codes anchor the
 * family-invalidation marker for their tokens, and token rows are the
 * revocation record verification reads.
 */
export async function cleanupOAuthHousekeeping(
  exec: Executor,
  now = new Date()
): Promise<OAuthHousekeepingResult> {
  const claims = await exec
    .delete(oauthAssertionClaims)
    .where(lt(oauthAssertionClaims.expiresAt, now))
    .returning({ jti: oauthAssertionClaims.jti });
  const requests = await exec
    .delete(oauthAuthorizationRequests)
    .where(lt(oauthAuthorizationRequests.expiresAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)))
    .returning({ id: oauthAuthorizationRequests.id });
  const staleBefore = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const staleClients = await exec
    .delete(oauthClients)
    .where(
      and(
        lt(oauthClients.createdAt, staleBefore),
        notExists(
          exec
            .select({ one: oauthGrants.id })
            .from(oauthGrants)
            .where(eq(oauthGrants.clientId, oauthClients.id))
        )
      )
    )
    .returning({ id: oauthClients.id });
  return {
    assertionClaimsDeleted: claims.length,
    authorizationRequestsDeleted: requests.length,
    staleClientsDeleted: staleClients.length
  };
}

// --- Connection management (settings surface) --------------------------------

export async function listGrantsForUser(exec: Executor, userId: string): Promise<OAuthGrantRow[]> {
  return exec
    .select()
    .from(oauthGrants)
    .where(eq(oauthGrants.userId, userId))
    .orderBy(desc(oauthGrants.createdAt));
}

export type ConnectionStatus = "active" | "revoked" | "expired";

export type ConnectionHistoryEntry = {
  action: string;
  /** Tool name for mcp.tool_called entries; null otherwise. Metadata only. */
  tool: string | null;
  createdAt: Date;
};

export type UserConnection = {
  grant: OAuthGrantRow;
  status: ConnectionStatus;
  familyName: string | null;
  familyTimezone: string;
  /** Accounts the grant's ceiling names, in ceiling order. null means the
   * grant has no ceiling — all accounts the user can access. An id whose
   * account was since deleted is dropped (it grants access to nothing). */
  accounts: { id: string; name: string }[] | null;
  /** Latest audit events for this connection, newest first. */
  history: ConnectionHistoryEntry[];
};

const CONNECTION_HISTORY_LIMIT = 10;
const CONNECTION_HISTORY_ACTIONS = [
  "oauth_grant.created",
  "oauth_grant.revoked",
  "oauth_grant.ssis_access_changed",
  "mcp.tool_called"
];

/**
 * Everything the Connected AI agents settings page renders, for the
 * signed-in user only. Pure database reads — this never consults the
 * MCP config gate, so connections stay visible (with their history)
 * even when MCP is unconfigured; the grants tables exist regardless.
 */
export async function listConnectionsForUser(
  exec: Executor,
  userId: string
): Promise<UserConnection[]> {
  const grants = await listGrantsForUser(exec, userId);
  if (grants.length === 0) return [];

  const familyIds = [...new Set(grants.map((g) => g.familyId))];
  const familyRows = await exec
    .select({ id: families.id, name: families.name, timezone: families.timezone })
    .from(families)
    .where(inArray(families.id, familyIds));
  const familyById = new Map(familyRows.map((f) => [f.id, f]));

  const ceilingIds = [...new Set(grants.flatMap((g) => g.accountIds))];
  const accountRows =
    ceilingIds.length > 0
      ? await exec
          .select({ id: accounts.id, name: accounts.name })
          .from(accounts)
          .where(inArray(accounts.id, ceilingIds))
      : [];
  const accountNameById = new Map(accountRows.map((a) => [a.id, a.name]));

  const grantIds = grants.map((g) => g.id);
  const historyRows = await exec
    .select({
      entityId: auditEvents.entityId,
      action: auditEvents.action,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, "oauth_grant"),
        inArray(auditEvents.entityId, grantIds),
        inArray(auditEvents.action, CONNECTION_HISTORY_ACTIONS)
      )
    )
    .orderBy(desc(auditEvents.createdAt));
  const historyByGrant = new Map<string, ConnectionHistoryEntry[]>();
  for (const row of historyRows) {
    if (!row.entityId) continue;
    const list = historyByGrant.get(row.entityId) ?? [];
    if (list.length >= CONNECTION_HISTORY_LIMIT) continue;
    const metadata = (row.metadata ?? {}) as { tool?: unknown };
    list.push({
      action: row.action,
      tool: typeof metadata.tool === "string" ? metadata.tool : null,
      createdAt: row.createdAt
    });
    historyByGrant.set(row.entityId, list);
  }

  const now = new Date();
  return grants.map((grant) => {
    const family = familyById.get(grant.familyId);
    return {
      grant,
      status:
        grant.status === "revoked" ? "revoked" : grant.expiresAt <= now ? "expired" : "active",
      familyName: family?.name ?? null,
      familyTimezone: family?.timezone ?? "UTC",
      accounts:
        grant.accountIds.length === 0
          ? null
          : grant.accountIds
              .filter((id) => accountNameById.has(id))
              .map((id) => ({ id, name: accountNameById.get(id)! })),
      history: historyByGrant.get(grant.id) ?? []
    };
  });
}

/**
 * Owner-only toggle of a connection's SSIS permission. Only the grant's
 * owner may change it (the lookup is scoped by userId, exactly like
 * revocation), and because MCP access resolution re-reads the grant row
 * on every call, the change takes effect on the very next tool call —
 * no token reissue. Returns false when no grant with that id belongs to
 * the user. Audited only when the value actually changes; the metadata
 * carries the flag and client id, never SSIS data.
 */
export async function setGrantSsisAccess(
  exec: Executor,
  grantId: string,
  userId: string,
  enabled: boolean
): Promise<boolean> {
  const [grant] = await exec
    .select()
    .from(oauthGrants)
    .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.userId, userId)))
    .limit(1);
  if (!grant) return false;
  if (grant.ssisAccess !== enabled) {
    await exec
      .update(oauthGrants)
      .set({ ssisAccess: enabled, updatedAt: new Date() })
      .where(eq(oauthGrants.id, grantId));
    await recordAudit(exec, {
      familyId: grant.familyId,
      actorUserId: userId,
      action: "oauth_grant.ssis_access_changed",
      entityType: "oauth_grant",
      entityId: grantId,
      metadata: { clientId: grant.clientId, ssisAccess: enabled }
    });
  }
  return true;
}

/** Owner-initiated disconnect. Effective on the very next call because
 * verification reads grant/token state live. */
export async function revokeGrant(
  exec: Executor,
  grantId: string,
  userId: string
): Promise<boolean> {
  const [grant] = await exec
    .select()
    .from(oauthGrants)
    .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.userId, userId)))
    .limit(1);
  if (!grant) return false;
  if (grant.status !== "revoked") {
    const now = new Date();
    await exec
      .update(oauthGrants)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(eq(oauthGrants.id, grantId));
    await exec
      .update(oauthTokens)
      .set({ revokedAt: now })
      .where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)));
    await recordAudit(exec, {
      familyId: grant.familyId,
      actorUserId: userId,
      action: "oauth_grant.revoked",
      entityType: "oauth_grant",
      entityId: grantId,
      metadata: { clientId: grant.clientId }
    });
  }
  return true;
}

// --- Resource-server verification (per-call re-resolution) -------------------

export type McpAccess = {
  actor: Actor;
  family: Family;
  grant: OAuthGrantRow;
};

/**
 * Verify an MCP bearer token and rebuild the caller's authority from
 * CURRENT database state. The token row proves a grant existed; everything
 * else — user alive, household membership, family — is re-read now.
 */
export async function resolveMcpAccess(
  exec: Executor,
  rawToken: string,
  config: McpConfig
): Promise<McpAccess | null> {
  const clean = rawToken.trim();
  if (!clean) return null;
  const [token] = await exec
    .select()
    .from(oauthTokens)
    .where(and(eq(oauthTokens.tokenHash, hashToken(clean)), eq(oauthTokens.kind, "access")))
    .limit(1);
  if (!token || token.revokedAt || token.expiresAt <= new Date()) return null;
  if (token.resource !== config.resourceUrl) return null;

  const [grant] = await exec
    .select()
    .from(oauthGrants)
    .where(eq(oauthGrants.id, token.grantId))
    .limit(1);
  if (!grant || grant.status !== "active" || grant.expiresAt <= new Date()) return null;

  // Durable family invalidation: a token whose family root was
  // invalidated (code replay / refresh reuse) is dead even if its own
  // row was inserted after the invalidation sweep — e.g. by an issuer
  // that was in flight when the replay landed.
  if (token.codeId) {
    const [code] = await exec
      .select({ invalidatedAt: oauthAuthorizationCodes.invalidatedAt })
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.id, token.codeId))
      .limit(1);
    if (code?.invalidatedAt) return null;
  }

  const [user] = await exec.select().from(users).where(eq(users.id, grant.userId)).limit(1);
  if (!user || user.removedAt) return null;
  // Household binding: the grant names ONE household. If the user's
  // household has changed since consent, reject — never follow the user
  // into a different household with a grant issued for the old one.
  if (user.familyId !== grant.familyId) return null;

  const [family] = await exec
    .select()
    .from(families)
    .where(eq(families.id, grant.familyId))
    .limit(1);
  if (!family) return null;

  const now = new Date();
  await exec.update(oauthTokens).set({ lastUsedAt: now }).where(eq(oauthTokens.id, token.id));
  await exec.update(oauthGrants).set({ lastUsedAt: now }).where(eq(oauthGrants.id, grant.id));

  const actor: Actor = {
    userId: user.id,
    // The grant id doubles as the consent/session identifier for the
    // connection (the binding's sid-equivalent in this design).
    sessionId: `oauth:${grant.id}`,
    familyId: grant.familyId,
    familyRole: user.familyRole as Actor["familyRole"],
    // MCP connections never carry platform admin (API-key precedent).
    platformRole: "user",
    email: user.email,
    name: user.name,
    emailVerified: !!user.emailVerifiedAt,
    authProvider: "oauth"
  };
  return { actor, family, grant };
}
