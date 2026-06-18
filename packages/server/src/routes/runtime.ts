import { runtime } from "@meos/contracts";
import type { WorkerHealthRecord } from "@meos/core";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { routeSchema } from "../route-schema.js";
import { HEARTBEAT_STALE_MS } from "../runtime/process-split.js";

const tags = ["runtime"];

/** Parse a SQLite `datetime('now')` UTC timestamp ("YYYY-MM-DD HH:MM:SS") to ms. */
function heartbeatMs(iso: string): number {
  return new Date(iso.replace(" ", "T") + "Z").getTime();
}

/**
 * Map a persisted worker-health row (written by the worker host, #94) to the
 * public contract shape. A heartbeat older than the staleness window means the
 * worker process is not reporting — surface it as an error so a dead/wedged
 * worker is visible in the UI rather than silently frozen at its last snapshot.
 */
function fromRecord(record: WorkerHealthRecord, now: number): runtime.WorkerHealth {
  const stale = now - heartbeatMs(record.heartbeatAt) > HEARTBEAT_STALE_MS;
  return {
    name: record.name,
    status: stale ? "error" : (record.status as runtime.WorkerStatus),
    detail: stale ? "worker process not reporting (stale heartbeat)" : (record.detail ?? undefined),
    lastError: stale ? "no heartbeat from the worker process" : (record.lastError ?? null),
    lastRunAt: record.lastRunAt ?? null,
    queue: record.queue as runtime.WorkerHealth["queue"],
  };
}

/**
 * GET /api/runtime — a read-only snapshot of every background worker's health
 * (watcher, connectors, scheduler, ingest + wiki queues). When the runtime is
 * split (#94) the heavy workers run in the worker host, so their health lives in
 * the `worker_health` table; we merge those persisted rows with this process's
 * own in-memory workers (the in-process snapshot wins on name collision). In
 * single-process mode the table is empty and this is exactly the old behavior.
 * Validated against the public contract so the shape can't drift.
 */
export function registerRuntimeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/api/runtime",
    {
      schema: routeSchema({
        tags,
        summary: "Runtime worker health",
        response: runtime.RuntimeHealthSchema,
      }),
    },
    async () => {
      const inProcess = ctx.workers.health();
      const seen = new Set(inProcess.map((w) => w.name));
      const now = Date.now();
      const persisted = ctx.store
        .listWorkerHealth()
        .filter((r) => !seen.has(r.name))
        .map((r) => fromRecord(r, now));
      return runtime.RuntimeHealthSchema.parse({ workers: [...inProcess, ...persisted] });
    },
  );
}
