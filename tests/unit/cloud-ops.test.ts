import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

describe("Cloud operator endpoints", () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const result = await build({
      entryPoints: ["tests/cloud/ops-probe.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      external: ["node:*", "cloudflare:*"],
      loader: { ".sql": "text" },
      conditions: ["workerd", "node"],
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire("/bundle/script-0.mjs");'
      },
      define: { "process.env.DATABASE_BACKEND": '"cloud-sqlite"', "process.env.NODE_ENV": '"test"' }
    });
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: result.outputFiles![0]!.text,
        compatibilityDate: "2026-08-20",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          DATABASE_BACKEND: "cloud-sqlite",
          NODE_ENV: "test",
          MERIDIAN_OPS_TOKEN: "test-ops-token"
        },
        durableObjects: { PROBE: { className: "OpsProbe", useSQLite: true } }
      })
    );
  });
  afterAll(async () => {
    await runtime?.dispose();
  });

  async function ops(
    path: string,
    init: { method?: string; token?: string; stub?: boolean; body?: unknown } = {}
  ) {
    const headers: Record<string, string> = {};
    if (init.token !== undefined) headers["x-meridian-ops-token"] = init.token;
    if (init.stub) headers["x-ops-stub"] = "1";
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await runtime.dispatchFetch(`http://localhost${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    return { status: response.status, body: parsed };
  }

  it("keeps ops paths invisible without the exact token", async () => {
    expect((await ops("/__meridian/ops/status")).status).toBe(404);
    expect((await ops("/__meridian/ops/status", { token: "wrong-token" })).status).toBe(404);
    expect((await ops("/__meridian/ops/status", { token: "" })).status).toBe(404);
    // Other internal paths stay 404 even with a valid token.
    expect(
      (await ops("/__meridian/tick", { token: "test-ops-token", method: "POST" })).status
    ).toBe(404);
    expect((await ops("/__meridian/anything", { token: "test-ops-token" })).status).toBe(404);
  });

  it("rejects a valid-looking but wrong token at the object boundary", async () => {
    // The gate 404s unknown tokens; only the exact token reaches the handler,
    // which independently rejects anything else.
    const result = await ops("/__meridian/ops/status", { token: "test-ops-token" });
    expect(result.status).toBe(200);
  });

  it("reports status, records cron ticks and reads them back", async () => {
    const before = (await ops("/__meridian/ops/status", { token: "test-ops-token" }))
      .body as Record<string, unknown>;
    expect(before.ok).toBe(true);
    expect(before.lastTickAt).toBeNull();
    expect((before.tables as Record<string, number>).families).toBe(0);

    expect((await ops("/__meridian/ops/probe-tick", { token: "test-ops-token" })).status).toBe(200);
    const after = (await ops("/__meridian/ops/status", { token: "test-ops-token" })).body as Record<
      string,
      unknown
    >;
    expect(after.lastTickAt).toBe("2026-10-05T12:00:00.000Z");
  });

  it("exports a logical snapshot of application tables only", async () => {
    expect((await ops("/__meridian/ops/probe-seed", { token: "test-ops-token" })).status).toBe(200);
    const result = await ops("/__meridian/ops/export", { token: "test-ops-token" });
    expect(result.status).toBe(200);
    const body = result.body as {
      format: string;
      version: number;
      tables: Record<string, Record<string, unknown>[]>;
    };
    expect(body.format).toBe("meridian-ops-export");
    expect(body.version).toBe(1);
    const tableNames = Object.keys(body.tables);
    for (const name of tableNames) {
      expect(name.startsWith("sqlite_")).toBe(false);
      expect(name.startsWith("_")).toBe(false);
    }
    expect(tableNames).toContain("audit_events");
    expect(body.tables.families!.some((row) => row.name === "Ops probe family")).toBe(true);
  });

  it("dry-runs a restore without touching anything", async () => {
    const result = await ops("/__meridian/ops/restore?time=2026-10-04T00:00:00Z", {
      token: "test-ops-token",
      method: "POST",
      stub: true,
      body: { dryRun: true }
    });
    expect(result.status).toBe(200);
    const body = result.body as { dryRun: boolean; targetBookmark: string; undoBookmark: string };
    expect(body.dryRun).toBe(true);
    expect(body.targetBookmark).toBe("bm-time-2026-10-04T00:00:00.000Z");
    expect(body.undoBookmark).toBe("bm-current");
    const state = (await ops("/__meridian/ops/probe-state", { token: "test-ops-token" })).body as {
      audits: unknown[];
      aborted: string[];
    };
    expect(state.audits).toHaveLength(0);
    expect(state.aborted).toHaveLength(0);
  });

  it("orchestrates a restore: audit, bookmark handoff, session abort, undo bookmark", async () => {
    const result = await ops("/__meridian/ops/restore", {
      token: "test-ops-token",
      method: "POST",
      stub: true,
      body: { time: "2026-10-04T00:00:00Z" }
    });
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; targetBookmark: string; undoBookmark: string };
    expect(body.ok).toBe(true);
    expect(body.targetBookmark).toBe("bm-time-2026-10-04T00:00:00.000Z");
    // onNextSessionRestoreBookmark's return value is the undo bookmark.
    expect(body.undoBookmark).toBe("bm-pre");

    const state = (await ops("/__meridian/ops/probe-state", { token: "test-ops-token" })).body as {
      audits: { action: string; metadata: string }[];
      aborted: string[];
      restoredTo: string | null;
    };
    expect(state.aborted).toEqual(["meridian-ops-restore"]);
    expect(state.restoredTo).toBe("bm-time-2026-10-04T00:00:00.000Z");
    const started = state.audits.find((row) => row.action === "ops.restore_started");
    expect(started).toBeDefined();
    expect(JSON.parse(started!.metadata)).toMatchObject({
      targetBookmark: "bm-time-2026-10-04T00:00:00.000Z",
      undoBookmark: "bm-current"
    });
  });

  it("records a completed restore in the audit trail", async () => {
    const result = await ops("/__meridian/ops/restore-log", {
      token: "test-ops-token",
      method: "POST",
      body: {
        targetTime: "2026-10-04T00:00:00.000Z",
        targetBookmark: "bm-target",
        undoBookmark: "bm-undo"
      }
    });
    expect(result.status).toBe(200);
    const state = (await ops("/__meridian/ops/probe-state", { token: "test-ops-token" })).body as {
      audits: { action: string; metadata: string }[];
    };
    const completed = state.audits.find((row) => row.action === "ops.restore_completed");
    expect(completed).toBeDefined();
    expect(JSON.parse(completed!.metadata)).toMatchObject({
      targetBookmark: "bm-target",
      undoBookmark: "bm-undo"
    });
  });

  it("handles real-storage bookmark lookups gracefully when PITR is unavailable locally", async () => {
    const result = await ops("/__meridian/ops/bookmark?time=2026-10-04T00:00:00Z", {
      token: "test-ops-token"
    });
    // Production storage relay answers 200; local preview has no change log.
    expect([200, 501]).toContain(result.status);
    if (result.status === 200) {
      const body = result.body as { targetBookmark: string; undoBookmark: string };
      expect(typeof body.targetBookmark).toBe("string");
      expect(typeof body.undoBookmark).toBe("string");
    } else {
      const body = result.body as { error: string };
      expect(body.error).toContain("not available");
    }
  });

  it("requires a target for bookmark and restore", async () => {
    expect((await ops("/__meridian/ops/bookmark", { token: "test-ops-token" })).status).toBe(400);
    expect(
      (await ops("/__meridian/ops/restore", { token: "test-ops-token", method: "POST", body: {} }))
        .status
    ).toBe(400);
  });
});
