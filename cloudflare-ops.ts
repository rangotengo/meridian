import { sql } from "drizzle-orm";
import type { CloudDatabase } from "./src/server/db/cloud/client";
import type { CloudStorage } from "./src/server/db/cloud/client";

/**
 * Operator-only maintenance endpoints. These live behind the internal host
 * (`meridian.internal`), which the public fetch handler never exposes: only
 * the worker itself (cron) or a request carrying the `MERIDIAN_OPS_TOKEN`
 * Worker secret on `/__meridian/ops/*` is forwarded there — everything else
 * keeps the existing 404 behaviour.
 */

export const OPS_BASE_PATH = "/__meridian/ops";
const OPS_TOKEN_HEADER = "x-meridian-ops-token";

/** Durable Object SQLite point-in-time recovery API (30-day window). */
export interface OpsPitr {
  getCurrentBookmark(): Promise<string>;
  getBookmarkForTime(timestamp: number | Date): Promise<string>;
  onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
}

export const OPS_STATE_TABLE = "ops_state";
export const OPS_LAST_TICK_KEY = "last_tick_at";

export type OpsDatabase = Pick<CloudDatabase, "execute">;

/** Compare a presented token against the expected secret without timing leaks. */
export async function opsTokenMatches(
  presented: string | undefined,
  expected: string | undefined
): Promise<boolean> {
  if (!presented || !expected) return false;
  const encode = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([encode(presented), encode(expected)]);
  if (a.length !== b.length) return false;
  let equal = true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) equal = false;
  return equal;
}

/**
 * Public-worker gate. Returns the internal request to forward into the
 * Durable Object, or null when the caller must receive the stock 404.
 */
export async function opsGate(
  request: Request,
  token: string | undefined
): Promise<Request | null> {
  const url = new URL(request.url);
  if (url.hostname === "meridian.internal") return null;
  if (!url.pathname.startsWith(`${OPS_BASE_PATH}/`)) return null;
  if (!(await opsTokenMatches(request.headers.get(OPS_TOKEN_HEADER) ?? undefined, token))) {
    return null;
  }
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  return new Request(`https://meridian.internal${url.pathname}${url.search}`, {
    method: request.method,
    headers: request.headers,
    body
  });
}

/** Creates the worker-owned bookkeeping table (not part of app migrations). */
export function ensureOpsStateTable(storage: CloudStorage): void {
  storage.sql.exec(
    `CREATE TABLE IF NOT EXISTS ${OPS_STATE_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  );
}

/** Records a successful cron tick; /api/health reports the latest value. */
export async function recordTick(db: OpsDatabase, at: Date = new Date()): Promise<void> {
  const table = sql.raw(OPS_STATE_TABLE);
  await db.execute(sql`
    INSERT INTO ${table} (key, value) VALUES (${OPS_LAST_TICK_KEY}, ${at.toISOString()})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
}

async function readLastTick(db: OpsDatabase): Promise<string | null> {
  const table = sql.raw(OPS_STATE_TABLE);
  const rows = await db.execute<{ value: string }>(
    sql`SELECT value FROM ${table} WHERE key = ${OPS_LAST_TICK_KEY}`
  );
  return rows.rows[0]?.value ?? null;
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

async function insertAuditEvent(
  db: OpsDatabase,
  action: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, family_id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
    VALUES (${crypto.randomUUID()}, NULL, NULL, ${action}, 'platform', 'ops', ${JSON.stringify(metadata)},
      ${new Date().toISOString()})
  `);
}

/** Lists application tables, excluding SQLite bookkeeping tables. */
async function userTables(db: OpsDatabase): Promise<string[]> {
  const rows = await db.execute<{ name: string }>(sql`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '\\_%' ESCAPE '\\'
      AND name NOT LIKE '_cf%'
    ORDER BY name
  `);
  return rows.rows.map((row) => row.name);
}

interface RestoreTarget {
  time?: number | string;
  bookmark?: string;
}

function parseRestoreTarget(
  url: URL,
  body: RestoreTarget | null
): { time?: number; bookmark?: string } | { error: string } {
  const timeParam = url.searchParams.get("time") ?? body?.time ?? undefined;
  const bookmarkParam = url.searchParams.get("bookmark") ?? body?.bookmark ?? undefined;
  if (bookmarkParam) return { bookmark: bookmarkParam };
  if (timeParam === undefined || timeParam === null || timeParam === "") {
    return { error: "Provide ?time= (ISO-8601 or epoch milliseconds) or ?bookmark=." };
  }
  const time =
    typeof timeParam === "number"
      ? timeParam
      : Number.isNaN(Number(timeParam))
        ? Date.parse(timeParam)
        : Number(timeParam);
  if (!Number.isFinite(time)) return { error: `Unparseable time: ${String(timeParam)}` };
  return { time };
}

async function dryRunReport(
  db: OpsDatabase,
  pitr: OpsPitr,
  target: { time?: number; bookmark?: string }
): Promise<Response> {
  const currentBookmark = await pitr.getCurrentBookmark();
  const targetBookmark = target.bookmark ?? (await pitr.getBookmarkForTime(new Date(target.time!)));
  return json({
    ok: true,
    dryRun: true,
    targetTime: target.time !== undefined ? new Date(target.time).toISOString() : null,
    targetBookmark,
    undoBookmark: currentBookmark,
    note: "undoBookmark restores the exact pre-restore state; keep it offline (it will be wiped from the database by the restore itself)."
  });
}

export interface OpsHandlers {
  db: OpsDatabase;
  pitr: OpsPitr;
  abort(message: string): void;
  token?: string;
}

/** Handles `/__meridian/ops/*` requests inside the Durable Object. */
export async function handleOpsEndpoints(request: Request, ops: OpsHandlers): Promise<Response> {
  try {
    return await routeOpsEndpoints(request, ops);
  } catch (error) {
    return Response.json(
      { ok: false, error: "Ops endpoint failed", detail: String(error) },
      { status: 500 }
    );
  }
}

async function routeOpsEndpoints(request: Request, ops: OpsHandlers): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${OPS_BASE_PATH}/`)) {
    return json({ ok: false, error: "not-an-ops-path" }, 404);
  }
  if (!(await opsTokenMatches(request.headers.get(OPS_TOKEN_HEADER) ?? undefined, ops.token))) {
    return json({ ok: false, error: "invalid or missing ops token" }, 403);
  }

  const path = url.pathname.slice(OPS_BASE_PATH.length);

  if (request.method === "GET" && path === "/status") {
    const tables: Record<string, number> = {};
    for (const name of await userTables(ops.db)) {
      const counted = await ops.db.execute<{ count: number }>(
        sql`SELECT CAST(count(*) AS INTEGER) AS count FROM ${sql.raw(`"${name.replace(/"/g, '""')}"`)}`
      );
      tables[name] = Number(counted.rows[0]?.count ?? 0);
    }
    let pitr: Record<string, unknown> = { supported: false };
    try {
      pitr = { supported: true, currentBookmark: await ops.pitr.getCurrentBookmark() };
    } catch {
      pitr = {
        supported: false,
        note: "PITR is unavailable here (local preview does not keep a change log)."
      };
    }
    return json({
      ok: true,
      now: new Date().toISOString(),
      lastTickAt: await readLastTick(ops.db),
      tables,
      pitr
    });
  }

  if (request.method === "GET" && path === "/bookmark") {
    const target = parseRestoreTarget(url, null);
    if ("error" in target) return json({ ok: false, error: target.error }, 400);
    try {
      return await dryRunReport(ops.db, ops.pitr, target);
    } catch (error) {
      return json(
        {
          ok: false,
          error: "Point-in-time recovery is not available in this runtime.",
          detail: String(error)
        },
        501
      );
    }
  }

  if (request.method === "POST" && path === "/restore") {
    let body: (RestoreTarget & { dryRun?: boolean }) | null = null;
    try {
      body = request.headers.get("content-type")?.includes("application/json")
        ? ((await request.json()) as RestoreTarget & { dryRun?: boolean })
        : null;
    } catch {
      body = null;
    }
    const target = parseRestoreTarget(url, body);
    if ("error" in target) return json({ ok: false, error: target.error }, 400);
    if (body?.dryRun || url.searchParams.get("dryRun") === "1") {
      return dryRunReport(ops.db, ops.pitr, target);
    }

    let undoBookmark: string;
    let targetBookmark: string;
    try {
      undoBookmark = await ops.pitr.getCurrentBookmark();
      targetBookmark =
        target.bookmark ?? (await ops.pitr.getBookmarkForTime(new Date(target.time!)));
      // The restore wipes everything written after targetBookmark — including
      // this audit row — so the operator script must also keep undoBookmark
      // offline (it does) and re-record the completed restore afterwards.
      await insertAuditEvent(ops.db, "ops.restore_started", {
        targetTime: target.time !== undefined ? new Date(target.time).toISOString() : null,
        targetBookmark,
        undoBookmark
      });
    } catch (error) {
      return json(
        {
          ok: false,
          error: "Point-in-time recovery is not available in this runtime.",
          detail: String(error)
        },
        501
      );
    }
    let preRestoreBookmark: string;
    try {
      preRestoreBookmark = await ops.pitr.onNextSessionRestoreBookmark(targetBookmark);
    } catch (error) {
      await insertAuditEvent(ops.db, "ops.restore_rejected", {
        targetBookmark,
        undoBookmark,
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
      return json(
        {
          ok: false,
          error: "Point-in-time recovery is not available in this runtime.",
          detail: String(error)
        },
        501
      );
    }
    // Never returns: the session aborts and the object restarts at the bookmark.
    ops.abort("meridian-ops-restore");
    return json({
      ok: true,
      targetBookmark,
      undoBookmark: preRestoreBookmark,
      note: "unreachable if restore proceeds"
    });
  }

  if (request.method === "POST" && path === "/restore-log") {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "JSON body required" }, 400);
    }
    await insertAuditEvent(ops.db, "ops.restore_completed", {
      targetTime: body.targetTime ?? null,
      targetBookmark: body.targetBookmark ?? null,
      undoBookmark: body.undoBookmark ?? null
    });
    return json({ ok: true });
  }

  if (request.method === "GET" && path === "/export") {
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const name of await userTables(ops.db)) {
      const exported = await ops.db.execute(
        sql`SELECT * FROM ${sql.raw(`"${name.replace(/"/g, '""')}"`)}`
      );
      tables[name] = exported.rows;
    }
    return json({
      format: "meridian-ops-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      note: "Logical snapshot of the Durable Object database. Contains encrypted (ciphertext) credential columns only; no Worker secrets. Store encrypted and offline.",
      tables
    });
  }

  return json({ ok: false, error: `Unknown ops endpoint: ${request.method} ${path}` }, 404);
}
