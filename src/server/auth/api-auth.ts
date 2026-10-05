import { verifyApiKey } from "@/server/domain/api-keys";
import { getDb } from "@/server/db/client";
import { consumeRateLimit } from "@/server/security/rate-limit";
import { hashToken } from "@/lib/crypto";
import { DomainError } from "@/lib/errors";
import type { Actor } from "./context";

// Failed API key verifications are rate limited per client IP (or, when no
// trusted IP is available, per presented token hash) to blunt brute-force
// guessing of `mr_live_` keys.
const FAILED_KEY_LIMIT = 20;
const FAILED_KEY_WINDOW_SECONDS = 900;

export function extractApiKeyFromRequest(requestHeaders: Headers): string | null {
  const authHeader = requestHeaders.get("authorization");
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0] && parts[0].toLowerCase() === "bearer" && parts[1]) {
      return parts[1].trim();
    }
  }

  const xApiKey = requestHeaders.get("x-api-key");
  if (xApiKey) {
    return xApiKey.trim();
  }

  return null;
}

function trustedClientKey(requestHeaders: Headers): string | null {
  const trustProxy =
    process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY_HEADERS === "true";
  if (!trustProxy) return null;
  const forwarded = requestHeaders.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0 && parts[0]) return parts[0];
  }
  return requestHeaders.get("x-real-ip");
}

/**
 * Authenticates a /api/v1 request. API key only: the browser session is never
 * accepted as a fallback, so these endpoints carry no ambient cookie
 * credentials and are safe for non-browser clients behind Cloudflare Access.
 */
export async function authenticateApiRequest(req: Request): Promise<Actor> {
  const token = extractApiKeyFromRequest(req.headers);
  if (!token) {
    throw new DomainError(
      "auth.required",
      "Missing API key. Pass 'Authorization: Bearer <api_key>' or 'X-API-Key: <api_key>'.",
      { status: 401 }
    );
  }

  const db = getDb();
  const actor = await verifyApiKey(db, token);
  if (actor) {
    return actor;
  }

  // Count the failure; once the window limit is exceeded this throws a 429
  // DomainError instead of the usual 401.
  const clientKey = trustedClientKey(req.headers) ?? hashToken(token).slice(0, 16);
  await consumeRateLimit(
    db,
    `api-key-fail:${clientKey}`,
    FAILED_KEY_LIMIT,
    FAILED_KEY_WINDOW_SECONDS
  );

  throw new DomainError("auth.invalid_api_key", "Invalid or revoked API key.", { status: 401 });
}
