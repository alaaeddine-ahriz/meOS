import { createContext } from "./context.js";
import { repairSourcePaths } from "./repair.js";
import { SchedulerWorker } from "./runtime/workers.js";
import { startScheduler } from "./scheduler.js";
import { buildServer } from "./server.js";

const ctx = createContext();
const app = await buildServer(ctx);
repairSourcePaths(ctx.store);
// Version the knowledge base from the start so every wiki change is committed
// and diffable; adding a remote to push to stays the user's choice (Settings).
if (!ctx.git.isInitialized()) {
  try {
    await ctx.git.init();
  } catch (error) {
    console.error("[git] auto-init failed:", error instanceof Error ? error.message : error);
  }
}
// Start the background workers through the registry, preserving the historical
// watcher → connectors → scheduler ordering. The watcher + connectors are
// already registered (in that order) on the context; the scheduler's Cron is
// built here and registered last, so it starts after the others — exactly as
// before, just routed through ctx.workers instead of ad-hoc calls.
const scheduler = startScheduler(ctx);
ctx.workers.register(new SchedulerWorker(scheduler));
await ctx.workers.startAll();

await app.listen({ port: ctx.config.server.port, host: "127.0.0.1" });

const shutdown = async () => {
  // Stop in reverse registration order: scheduler → connectors → watcher.
  await ctx.workers.stopAll();
  await app.close();
  ctx.db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// When the desktop shell spawned us, exit with it even if it died without
// saying goodbye (SIGKILL, crash): once the parent is gone we get reparented,
// so a changed ppid means the shell is no more.
if (process.env["MEOS_EXIT_WITH_PARENT"] === "1") {
  const parentPid = process.ppid;
  setInterval(() => {
    if (process.ppid !== parentPid) void shutdown();
  }, 2000).unref();
}
