import { createLogger } from "@meos/core";
import { type AppContext, createContext, recoverWikiBacklog } from "./context.js";
import { repairSourcePaths } from "./repair.js";
import { resolveSplitRole, WorkerSupervisor } from "./runtime/process-split.js";
import { SchedulerWorker } from "./runtime/workers.js";
import { startScheduler } from "./scheduler.js";
import { buildServer } from "./server.js";

const log = createLogger("git");

/**
 * Translate the two startup failures users actually hit into one actionable line
 * instead of a raw stack. Both otherwise present as a confusing dead app:
 *  - ERR_DLOPEN_FAILED — a native module (better-sqlite3) compiled for a different
 *    Node ABI than the one running. The server dies before binding, so the only
 *    visible symptom is ECONNREFUSED in the web pane. The repo pins Node 22
 *    (.nvmrc); `nvm use` + `pnpm install` rebuilds native modules to match.
 *  - EADDRINUSE — a second `pnpm dev`/`pnpm desktop` racing for the same port.
 */
function fatalStartup(error: unknown, port?: number): never {
  const e = error as { code?: string; message?: string };
  if (e?.code === "ERR_DLOPEN_FAILED" || /NODE_MODULE_VERSION/.test(e?.message ?? "")) {
    log.error(
      { err: error },
      `meOS couldn't load a native module — it was built for a different Node version ` +
        `(you're on Node ${process.version}). Run \`nvm use\` (the repo pins Node 22 in .nvmrc), ` +
        `then \`pnpm install\` to rebuild native modules, and start meOS again.`,
    );
  } else if (e?.code === "EADDRINUSE") {
    const p = port ?? 4321;
    log.error(
      { err: error },
      `meOS port ${p} is already in use — another meOS server is running. ` +
        `Stop it and retry: \`lsof -ti:${p} | xargs kill\`.`,
    );
  } else {
    log.error({ err: error }, "meOS failed to start");
  }
  process.exit(1);
}

// Process isolation (#94): in "app" role the heavy workers run in a forked worker
// host and this process only serves the UI + enqueues; "all" is today's single
// process. The role is opt-in (MEOS_WORKER_PROCESS=1) with MEOS_IN_PROCESS_WORKERS
// as the kill switch — see resolveSplitRole.
const role = resolveSplitRole();

let supervisor: WorkerSupervisor | undefined;
let ctx: AppContext;
try {
  if (role === "app") {
    // Fork the compiled sibling (dist/worker-host.js); under tsx (dev) the entry is
    // the .ts source and the child must load tsx too.
    const isTs = import.meta.url.endsWith(".ts");
    const entryUrl = new URL(isTs ? "./worker-host.ts" : "./worker-host.js", import.meta.url).href;
    supervisor = new WorkerSupervisor({ entryUrl, isTs });
    ctx = createContext(undefined, { role: "app", bridge: supervisor });
  } else {
    ctx = createContext();
  }
} catch (error) {
  // Opening the DB loads better-sqlite3 — the most common boot failure is its
  // native ABI not matching the running Node. Make that legible, not a raw stack.
  fatalStartup(error);
}

const app = await buildServer(ctx);
repairSourcePaths(ctx.store);
// Version the knowledge base from the start so every wiki change is committed
// and diffable; adding a remote to push to stays the user's choice (Settings).
if (!ctx.git.isInitialized()) {
  try {
    await ctx.git.init();
  } catch (error) {
    log.error({ err: error }, "auto-init failed");
  }
}

// In single-process mode this process owns the scheduler; in "app" mode the
// worker host does. Start the registered workers (app: watcher only; all: every
// worker), preserving the historical watcher → connectors → scheduler ordering.
if (role === "all") {
  const scheduler = startScheduler(ctx);
  ctx.workers.register(new SchedulerWorker(scheduler));
}
await ctx.workers.startAll();

// Single-process: drain any wiki backlog stranded by the last shutdown (#97).
// In "app" role the worker host owns this; here it would only run wiki work in
// the UI process.
if (role === "all") {
  const stale = recoverWikiBacklog(ctx);
  if (stale > 0) log.info({ stale }, `recovering ${stale} stale wiki page(s) after restart`);
}

// Fork the worker host AFTER migrations + git init have run here, so it opens an
// already-current schema and never races DDL or git init.
supervisor?.start();

try {
  await app.listen({ port: ctx.config.server.port, host: "127.0.0.1" });
} catch (error) {
  fatalStartup(error, ctx.config.server.port);
}

const shutdown = async () => {
  // Stop the worker host first, then this process's own workers + server.
  await supervisor?.stop();
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
