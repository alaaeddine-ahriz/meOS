import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { AppContext } from "./context.js";

/**
 * Watches data/inbox/watch — any file dropped there is ingested and then
 * moved to data/inbox/processed so it is never processed twice.
 */
export function startWatcher(ctx: AppContext): FSWatcher {
  const watchDir = path.join(ctx.config.dataDir, "inbox", "watch");
  const processedDir = path.join(ctx.config.dataDir, "inbox", "processed");
  fs.mkdirSync(processedDir, { recursive: true });

  const watcher = chokidar.watch(watchDir, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on("add", (filePath) => {
    const filename = path.basename(filePath);
    if (filename.startsWith(".")) return;
    const inboxItemId = ctx.store.createInboxItem(filename);
    ctx.queue.push(async () => {
      const buffer = fs.readFileSync(filePath);
      await ctx.pipeline.ingest({ kind: "file", filename, buffer, origin: "watch" }, inboxItemId);
      const target = path.join(processedDir, `${Date.now()}-${filename}`);
      fs.renameSync(filePath, target);
    });
  });

  return watcher;
}
