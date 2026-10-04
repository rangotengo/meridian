import { sql } from "drizzle-orm";
import { createCloudDatabase, type CloudStorage } from "../../src/server/db/cloud/client";
import { migrateCloudStorage } from "../../src/server/db/cloud/migrate";
import { families } from "../../src/server/db/cloud/schema";
import {
  ensureOpsStateTable,
  handleOpsEndpoints,
  opsGate,
  recordTick,
  type OpsPitr
} from "../../cloudflare-ops";

type ProbeStorage = CloudStorage & OpsPitr;

/**
 * Test double for the operator endpoints in cloudflare-worker.ts. It uses the
 * real gate, the real handler code and real SQLite storage; only the OpenNext
 * app and the abort/PITR primitives (which need production storage relay) are
 * stubbed behind the `x-ops-stub` header.
 */
export class OpsProbe {
  private db;
  private ready;
  private abortedMessages: string[] = [];
  private restoredTo: string | null = null;
  constructor(private ctx: { storage: ProbeStorage }) {
    this.db = createCloudDatabase(ctx.storage);
    this.ready = migrateCloudStorage(ctx.storage).then(() => ensureOpsStateTable(ctx.storage));
  }
  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === "/__meridian/ops/probe-seed") {
      await this.db.insert(families).values({ name: "Ops probe family" });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__meridian/ops/probe-tick") {
      await recordTick(this.db, new Date("2026-10-05T12:00:00.000Z"));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__meridian/ops/probe-state") {
      const audits = await this.db.execute(
        sql`SELECT action, metadata FROM audit_events WHERE action LIKE 'ops.%' ORDER BY created_at`
      );
      return Response.json({
        audits: audits.rows,
        aborted: this.abortedMessages,
        restoredTo: this.restoredTo
      });
    }

    const pitr: OpsPitr =
      request.headers.get("x-ops-stub") === "1"
        ? {
            getCurrentBookmark: async () => "bm-current",
            getBookmarkForTime: async (t) =>
              `bm-time-${(t instanceof Date ? t : new Date(t)).toISOString()}`,
            onNextSessionRestoreBookmark: async (bookmark) => {
              this.restoredTo = bookmark;
              return "bm-pre";
            }
          }
        : this.ctx.storage;
    return handleOpsEndpoints(request, {
      db: this.db,
      pitr,
      abort: (message) => {
        this.abortedMessages.push(message);
      },
      token: "test-ops-token"
    });
  }
}

const worker = {
  async fetch(
    request: Request,
    env: {
      PROBE: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
      MERIDIAN_OPS_TOKEN?: string;
    }
  ): Promise<Response> {
    const opsRequest = await opsGate(request, env.MERIDIAN_OPS_TOKEN);
    if (opsRequest) return env.PROBE.getByName("ops").fetch(opsRequest);
    return new Response("Not found", { status: 404 });
  }
};

export default worker;
