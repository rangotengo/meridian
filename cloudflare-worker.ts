// @ts-expect-error OpenNext generates this JavaScript module during the build.
import app from "./.open-next/worker.js";
import { createCloudDatabase, type CloudStorage } from "./src/server/db/cloud/client";
import { cloudDatabaseContext } from "./src/server/db/cloud/context";
import { migrateCloudStorage } from "./src/server/db/cloud/migrate";
import { getDb } from "./src/server/db/client";
import {
  ensureOpsStateTable,
  handleOpsEndpoints,
  OPS_BASE_PATH,
  opsGate,
  recordTick,
  type OpsPitr
} from "./cloudflare-ops";
import { createJobRegistry, registerWorkerBootstraps } from "./src/server/queue/jobs";
import {
  claimBatch,
  completeJob,
  failJob,
  recoverStaleJobs,
  runDueCrons
} from "./src/server/queue/worker-loop";

interface WorkerEnv {
  MERIDIAN_DB: {
    getByName(name: string): { fetch(request: Request): Promise<Response> };
  };
  /**
   * Operator secret. When set, `/__meridian/ops/*` requests carrying it in
   * the `x-meridian-ops-token` header are forwarded into the Durable Object
   * for point-in-time recovery and snapshot exports. Unset → always 404.
   */
  MERIDIAN_OPS_TOKEN?: string;
}
interface ObjectContext {
  storage: CloudStorage & OpsPitr;
  abort(message: string): void;
  waitUntil(promise: Promise<unknown>): void;
}

export class MeridianDatabase {
  private readonly db;
  private readonly ready;
  constructor(
    private readonly ctx: ObjectContext,
    private readonly env: WorkerEnv
  ) {
    this.db = createCloudDatabase(ctx.storage);
    this.ready = migrateCloudStorage(ctx.storage).then(() => ensureOpsStateTable(ctx.storage));
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    return cloudDatabaseContext.run(this.db, async () => {
      const url = new URL(request.url);
      if (url.hostname === "meridian.internal" && url.pathname.startsWith(`${OPS_BASE_PATH}/`)) {
        return handleOpsEndpoints(request, {
          db: this.db,
          pitr: this.ctx.storage,
          abort: (message) => this.ctx.abort(message),
          token: this.env.MERIDIAN_OPS_TOKEN
        });
      }
      if (url.hostname === "meridian.internal" && url.pathname === "/__meridian/tick") {
        const db = getDb();
        await registerWorkerBootstraps(db);
        await recoverStaleJobs(db);
        await runDueCrons(db);
        const registry = await createJobRegistry();
        const started = Date.now();
        let completed = 0;
        // Claim one at a time so work left for the next invocation stays pending.
        while (completed < 5 && Date.now() - started < 20000) {
          const [job] = await claimBatch(db, "cloudflare", 1);
          if (!job) break;
          try {
            const handler = registry.get(job.queue);
            if (!handler) throw new Error(`Unknown queue: ${job.queue}`);
            await handler(job.payload as Record<string, unknown>, db);
            await completeJob(db, job.id);
          } catch (error) {
            await failJob(db, job, error);
          }
          completed++;
        }
        await recordTick(this.db);
        return Response.json({ processed: completed });
      }
      return app.fetch(request, this.env, {
        waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise),
        passThroughOnException() {
          /* Durable Object errors are handled by the Worker. */
        }
      });
    });
  }
}

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const opsRequest = await opsGate(request, env.MERIDIAN_OPS_TOKEN);
    if (opsRequest) return env.MERIDIAN_DB.getByName("meridian-v1").fetch(opsRequest);
    if (url.hostname === "meridian.internal" || url.pathname.startsWith("/__meridian/")) {
      return new Response("Not found", { status: 404 });
    }
    return env.MERIDIAN_DB.getByName("meridian-v1").fetch(request);
  },
  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    const response = await env.MERIDIAN_DB.getByName("meridian-v1").fetch(
      new Request("https://meridian.internal/__meridian/tick", { method: "POST" })
    );
    if (!response.ok) throw new Error(`Scheduled work failed (${response.status})`);
  }
};

export default worker;
