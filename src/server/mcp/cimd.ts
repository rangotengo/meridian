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
  const raw = await fetcher(clientId);
  const parsed = cimdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Client metadata document is malformed.");
  }
  const data = parsed.data;
  if (data.client_id !== clientId) {
    throw new Error("Client metadata document client_id does not match its URL.");
  }
  const doc: CimdDocument = {
    clientId: data.client_id,
    clientName: data.client_name ?? "Unknown client",
    redirectUris: data.redirect_uris,
    tokenEndpointAuthMethod: data.token_endpoint_auth_method ?? "none",
    jwksUri: data.jwks_uri ?? null,
    jwks: (data.jwks as JSONWebKeySet | undefined) ?? null
  };
  docCache.set(clientId, { doc, fetchedAt: Date.now() });
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
  const raw = await fetcher(doc.jwksUri);
  const parsed = z.object({ keys: z.array(z.record(z.string(), z.unknown())) }).safeParse(raw);
  if (!parsed.success) throw new Error("Client JWKS document is malformed.");
  const jwks = parsed.data as JSONWebKeySet;
  jwksCache.set(doc.jwksUri, { jwks, fetchedAt: Date.now() });
  return jwks;
}

/**
 * Verify a `private_key_jwt` client assertion (RFC 7523): iss and sub are
 * the client_id, aud is the token endpoint URL, signature chains to the
 * keys published in the client's own metadata document.
 */
export async function verifyClientAssertion(
  doc: CimdDocument,
  assertion: string,
  tokenEndpointUrl: string,
  fetcher: MetadataFetcher = fetchMetadataJson,
  allowlist?: string[]
): Promise<void> {
  const jwks = await loadJwks(doc, fetcher, allowlist);
  if (!jwks) throw new Error("Client publishes no JWKS to verify its assertion against.");
  await jwtVerify(assertion, createLocalJWKSet(jwks), {
    issuer: doc.clientId,
    subject: doc.clientId,
    audience: tokenEndpointUrl,
    algorithms: ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384"]
  });
}

/** Exact-match redirect URI check, except loopback URIs which match
 * port-agnostically per RFC 8252 §7.3 (native-app / Claude Code clients). */
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
        loopback(got.hostname) &&
        reg.pathname === got.pathname
      ) {
        return true;
      }
    } catch {
      /* unparseable entries never match */
    }
  }
  return false;
}
