import { NextResponse } from "next/server";
import { isDomainError } from "@/lib/errors";
import { log } from "@/lib/logger";

// Shared request guards and error mapping for the /api/v1/shortcuts routes.

export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Mutating-request guard: requires an application/json Content-Type and
 * rejects cross-site requests (Sec-Fetch-Site / Origin), mirroring
 * src/app/api/chat/route.ts. Native clients such as iOS Shortcuts send
 // neither header, so absent values are allowed.
 */
export function guardMutatingRequest(req: Request): NextResponse | null {
  const contentType = req.headers.get("content-type");
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    return NextResponse.json(
      { ok: false, error: "Unsupported Media Type: expected application/json." },
      { status: 415 }
    );
  }

  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "same-site") {
    return NextResponse.json(
      { ok: false, error: "Cross-site requests are forbidden." },
      { status: 403 }
    );
  }

  const origin = req.headers.get("origin");
  let host = req.headers.get("host");
  if (!host) {
    try {
      host = new URL(req.url).host;
    } catch {
      host = null;
    }
  }
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        return NextResponse.json({ ok: false, error: "Invalid request origin." }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ ok: false, error: "Malformed origin header." }, { status: 403 });
    }
  }

  return null;
}

/**
 * Reads and parses a JSON request body with a hard size cap.
 * Returns a NextResponse (error) when the body is unusable.
 */
export async function readJsonBody(
  req: Request
): Promise<{ ok: true; data: unknown } | { ok: false; res: NextResponse }> {
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_BODY_BYTES) {
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, error: `Request payload exceeds ${MAX_BODY_BYTES / 1024}KB limit.` },
        { status: 413 }
      )
    };
  }

  const rawText = await req.text().catch(() => "");
  if (rawText.length > MAX_BODY_BYTES) {
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, error: `Request payload exceeds ${MAX_BODY_BYTES / 1024}KB limit.` },
        { status: 413 }
      )
    };
  }

  try {
    return { ok: true, data: JSON.parse(rawText) };
  } catch {
    return {
      ok: false,
      res: NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 })
    };
  }
}

/**
 * Maps errors to API responses: DomainErrors keep their status and user
 * message; anything else is logged server-side and answered with a generic
 * 500 so internal details never leak to the client.
 */
export function apiErrorResponse(err: unknown, route: string): NextResponse {
  if (isDomainError(err)) {
    return NextResponse.json({ ok: false, error: err.userMessage }, { status: err.status });
  }
  log.error({ err }, `${route}.failed`);
  return NextResponse.json(
    { ok: false, error: "The request could not be processed. Try again shortly." },
    { status: 500 }
  );
}
