import { createContext } from "./context.js";
import { repairSourcePaths } from "./repair.js";
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
ctx.watcher.start();
const scheduler = startScheduler(ctx);

await app.listen({ port: ctx.config.server.port, host: "127.0.0.1" });

const shutdown = async () => {
  scheduler.stop();
  await ctx.watcher.close();
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
