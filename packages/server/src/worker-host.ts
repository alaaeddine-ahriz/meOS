import { createLogger } from "@meos/core";
import { createContext, runConsolidationJob } from "./context.js";
import { HEARTBEAT_MS, type WorkerMessage } from "./runtime/process-split.js";
import { SchedulerWorker } from "./runtime/workers.js";
import { startScheduler } from "./scheduler.js";

/**
 * The forked worker host (#94, process isolation). It runs every heavy background
 * worker — the durable ingest executor, the scheduler/consolidation, connector
 * sync, and wiki regeneration — against the same SQLite database as the app
 * process, so heavy DB transactions and CPU passes never block the UI-facing
 * HTTP loop. It serves no HTTP; the app process spawns and supervises it (see
 * runtime/process-split.ts) and forwards merge-producing triggers over IPC.
 */
const log = createLogger("worker-host");

const ctx = createContext(undefined, { role: "worker" });

// Wiki regeneration commits locally, so make sure the repo is initialized. This
// is idempotent — the app process also inits before forking us — so it is a
// no-op in the normal path and only matters if the worker boots first.
if (!ctx.git.isInitialized()) {
  try {
    await ctx.git.init();
  } catch (error) {
    log.error({ err: error }, "git init failed");
  }
}

// The scheduler Cron is built here (the worker owns periodic consolidation) and
// registered last, preserving the historical connectors → scheduler ordering.
const scheduler = startScheduler(ctx);
ctx.workers.register(new SchedulerWorker(scheduler));
await ctx.workers.startAll();

// Heartbeat: publish each worker's health to the DB so the app process can
// surface it via GET /api/runtime without sharing memory. A stale heartbeat is
// how the app detects that this process has died.
const writeHealth = (): void => {
  if (!ctx.db.open) return;
  for (const worker of ctx.workers.list()) {
    try {
      ctx.store.upsertWorkerHealth(worker.health());
    } catch {
      /* best-effort: the DB may be mid-close on shutdown */
    }
  }
};
writeHealth();
const heartbeat = setInterval(writeHealth, HEARTBEAT_MS);
heartbeat.unref();

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  await ctx.workers.stopAll();
  ctx.db.close();
  process.exit(0);
};

// Commands forwarded by the app process. Coordination is otherwise via the DB;
// these keep user-facing latency low (pump) and route the few merge-producing
// triggers that originate in the app to this single writer process.
process.on("message", (msg: WorkerMessage) => {
  switch (msg.type) {
    case "pump":
      ctx.durableIngest.pump();
      break;
    case "event":
      if (msg.name === "onSessionEnd") void ctx.events.emit("onSessionEnd", msg.payload);
      break;
    case "connector":
      if (msg.action === "enqueueSync" && msg.args?.provider && msg.args.kind)
        ctx.connectors.enqueueSync(msg.args.provider, msg.args.kind);
      else if (msg.action === "reschedule") ctx.connectors.reschedule();
      else if (msg.action === "syncAllEnabled") ctx.connectors.syncAllEnabled();
      break;
    case "consolidate":
      ctx.queue.push(() => runConsolidationJob(ctx), { exclusive: true });
      break;
    case "shutdown":
      void shutdown();
      break;
  }
});

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// Die with the parent even on SIGKILL: the supervisor sets MEOS_EXIT_WITH_PARENT,
// so a changed ppid (we got reparented) means the app process is gone.
if (process.env["MEOS_EXIT_WITH_PARENT"] === "1") {
  const parentPid = process.ppid;
  setInterval(() => {
    if (process.ppid !== parentPid) void shutdown();
  }, 2000).unref();
}

log.info({ pid: process.pid }, "worker host ready");
