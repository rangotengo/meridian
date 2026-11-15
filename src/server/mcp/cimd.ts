/**
 * Client ID Metadata Document (CIMD) resolution and `private_key_jwt`
 * client-assertion verification.
 *
 * A CIMD client_id is an https URL; the document behind it is the client's
 * record (nothing is stored server-side for CIMD clients). Every fetch —
 * the document itself and any `jwks_uri` it names — goes through the
 * SSRF policy fetcher (src/server/mcp/ssrf.ts): `jose` verifies signatures
 * but is never allowed to fetch anything itself (the JWKS is loaded with
 * createLocalJWKSet from policy-fetched JSON).
 */
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { fetchMetadataJson, type MetadataFetcher } from "./ssrf";
import { usesCloudStorage } from "../db/dialect";

/**
 * Backend-specific fetch enforcement for client metadata:
 *  - Node: the SSRF fetcher resolves the host, validates every address,
 *    and pins the connection to a validated address — the destination is
 *    enforced, so no allowlist is needed.
 *  - Workers: fetch() resolves independently and offers no pinning, so a
 *    check-then-fetch sequence would be a TOCTOU/rebinding hole. On this
 *    backend fetching is therefore restricted to exact URLs the operator
 *    has allowlisted in configuration (MCP_CIMD_ALLOWLIST). Anything else
 *    is refused before any network call.
 */
function assertFetchAllowed(url: string, allowlist: string[] | undefined): void {
  if (usesCloudStorage && !(allowlist ?? []).includes(url)) {
    throw new Error(
      "Client metadata fetching on this deployment is restricted to operator-approved URLs."
    );
  }
}

/**
 * The safe-callback policy for OAuth redirect URIs, shared by DCR
 * registration and CIMD metadata validation: Meridian is a personal
 * instance, not a public developer platform, so callbacks are limited
 * to the two first-party AI clients' HTTPS endpoints and to loopback
 * (native apps / Claude Code, RFC 8252). Everything else — non-HTTP(S)
 * schemes such as javascript: or data:, credentialed URLs, fragments,
 * malformed URLs, arbitrary internet hosts — is rejected. A URI that
 * fails this policy must never be stored, consented to, or redirected
 * to, on success OR error paths.
 */
export function oauthRedirectUriAllowed(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.hash) return false;
  if (url.protocol === "https:") {
    return url.hostname === "claude.ai" || url.hostname === "chatgpt.com";
  }
  if (url.protocol === "http:") {
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  }
  return false;
}

export type CimdDocument = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "private_key_jwt";
  jwksUri: string | null;
  jwks: JSONWebKeySet | null;
};

const cimdSchema = z.object({
  client_id: z.string().min(1),
  client_name: z.string().min(1).optional(),
  redirect_uris: z.array(z.string().min(1)).min(1),
  token_endpoint_auth_method: z.enum(["none", "private_key_jwt"]).optional(),
  jwks_uri: z.string().min(1).optional(),
  jwks: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }).optional()
});

const CACHE_TTL_MS = 60 * 60 * 1000;
/** Hard size bound for the in-memory caches: client ids are attacker-
 * chosen URLs, so an unbounded cache is a memory-exhaustion surface.
 * Oldest entries (insertion order) are evicted past the bound. */
const CACHE_MAX_ENTRIES = 200;

function cacheSet<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value as K;
    cache.delete(oldest);
  }
}

const docCache = new Map<string, { doc: CimdDocument; fetchedAt: number }>();
const jwksCache = new Map<string, { jwks: JSONWebKeySet; fetchedAt: number }>();

export function clearCimdCaches(): void {
  docCache.clear();
  jwksCache.clear();
}

export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

export async function fetchCimdDocument(
  clientId: string,
  fetcher: MetadataFetcher = fetchMetadataJson,
  allowlist?: string[]
): Promise<CimdDocument> {
  const cached = docCache.get(clientId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.doc;

  assertFetchAllowed(clientId, allowlist);
  const raw = await fetcher(clientId, { allowlist });
  const parsed = cimdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Client metadata document is malformed.");
  }
  const data = parsed.data;
  if (data.client_id !== clientId) {
    throw new Error("Client metadata document client_id does not match its URL.");
  }
  // Every redirect URI in the document must satisfy the same safe-
  // callback policy as DCR registrations BEFORE the document is
  // accepted: an exact string match in redirectUriAllowed is not a
  // policy — a javascript:/data: URI in the document would otherwise
  // sail through authorize validation and reach the browser redirect.
  for (const uri of data.redirect_uris) {
    if (!oauthRedirectUriAllowed(uri)) {
      throw new Error(
        "Client metadata document contains a redirect URI outside the allowed policy."
      );
    }
  }
  const doc: CimdDocument = {
    clientId: data.client_id,
    clientName: data.client_name ?? "Unknown client",
    redirectUris: data.redirect_uris,
    tokenEndpointAuthMethod: data.token_endpoint_auth_method ?? "none",
    jwksUri: data.jwks_uri ?? null,
    jwks: (data.jwks as JSONWebKeySet | undefined) ?? null
  };
  cacheSet(docCache, clientId, { doc, fetchedAt: Date.now() });
  return doc;
}

async function loadJwks(
  doc: CimdDocument,
  fetcher: MetadataFetcher,
  allowlist?: string[]
): Promise<JSONWebKeySet | null> {
  if (doc.jwks) return doc.jwks;
  if (!doc.jwksUri) return null;
  const cached = jwksCache.get(doc.jwksUri);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.jwks;
  assertFetchAllowed(doc.jwksUri, allowlist);
  const raw = await fetcher(doc.jwksUri, { allowlist });
  const parsed = z.object({ keys: z.array(z.record(z.string(), z.unknown())) }).safeParse(raw);
  if (!parsed.success) throw new Error("Client JWKS document is malformed.");
  const jwks = parsed.data as JSONWebKeySet;
  cacheSet(jwksCache, doc.jwksUri, { jwks, fetchedAt: Date.now() });
  return jwks;
}

/** Maximum lifetime of a `private_key_jwt` client assertion (exp − iat). */
export const ASSERTION_MAX_LIFETIME_SECONDS = 300;
/** Clock skew tolerated on assertion iat/exp checks. */
export const ASSERTION_CLOCK_SKEW_SECONDS = 30;

export type VerifiedAssertion = {
  jti: string;
  /** Assertion expiry — the replay claim is held until this moment. */
  expiresAt: Date;
};

/**
 * Verify a `private_key_jwt` client assertion (RFC 7523): iss and sub are
 * the client_id, aud is the token endpoint URL, signature chains to the
 * keys published in the client's own metadata document.
 *
 * RFC 7523 §3 requires exp; iat and jti are required too, the lifetime
 * (exp − iat) is capped at five minutes, and the caller MUST claim the
 * returned (client_id, jti) pair atomically before authenticating the
 * client — an assertion that has been presented before is a replay, not
 * a credential. (jose validates exp only when present, so presence is
 * enforced via requiredClaims.)
 */
export async function verifyClientAssertion(
  doc: CimdDocument,
  assertion: string,
  tokenEndpointUrl: string,
  fetcher: MetadataFetcher = fetchMetadataJson,
  allowlist?: string[]
): Promise<VerifiedAssertion> {
  const jwks = await loadJwks(doc, fetcher, allowlist);
  if (!jwks) throw new Error("Client publishes no JWKS to verify its assertion against.");
  const { payload } = await jwtVerify(assertion, createLocalJWKSet(jwks), {
    issuer: doc.clientId,
    subject: doc.clientId,
    audience: tokenEndpointUrl,
    algorithms: ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384"],
    requiredClaims: ["exp", "iat", "jti"],
    clockTolerance: ASSERTION_CLOCK_SKEW_SECONDS
  });
  const iat = payload.iat!;
  const exp = payload.exp!;
  if (exp - iat > ASSERTION_MAX_LIFETIME_SECONDS) {
    throw new Error("Client assertion lifetime exceeds the maximum allowed.");
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw new Error("Client assertion carries no jti.");
  }
  return { jti: payload.jti, expiresAt: new Date(exp * 1000) };
}

/** Exact-match redirect URI check, except loopback URIs which match
 * port-agnostically per RFC 8252 §7.3 (native-app / Claude Code clients).
 * The loopback exception is deliberately narrow: the presented URI must
 * name the SAME loopback host, path, and query as the registered URI —
 * only the port may differ. A different loopback host or an added query
 * is a different callback, not the registered one. */
export function redirectUriAllowed(registered: string[], presented: string): boolean {
  for (const candidate of registered) {
    if (candidate === presented) return true;
    try {
      const reg = new URL(candidate);
      const got = new URL(presented);
      const loopback = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "[::1]";
      if (
        reg.protocol === "http:" &&
        loopback(reg.hostname) &&
        got.protocol === "http:" &&
        got.hostname === reg.hostname &&
        reg.pathname === got.pathname &&
        reg.search === got.search
      ) {
        return true;
      }
    } catch {
      /* unparseable entries never match */
    }
  }
  return false;
}
