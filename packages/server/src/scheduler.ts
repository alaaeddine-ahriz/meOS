import path from "node:path";
import { Cron } from "croner";
import { runConsolidation } from "@meos/core";
import type { AppContext } from "./context.js";

/** Nightly consolidation (§4.5) — queued so it never races with ingestion. */
export function startScheduler(ctx: AppContext): Cron {
  return new Cron(ctx.config.consolidation.cron, () => {
    ctx.queue.push(
      async () => {
        const report = await runConsolidation({
          store: ctx.store,
          llm: ctx.llm,
          wiki: ctx.wiki,
          digestDir: path.join(ctx.config.dataDir, "digests"),
        });
        console.log("[scheduler] nightly consolidation:", report);

        // Push the night's wiki/digest changes to the remote when the user
        // opted in. Failures (e.g. auth, offline) are logged, never fatal.
        if (ctx.store.getSetting<{ autoSync?: boolean }>("git")?.autoSync) {
          try {
            const status = await ctx.git.sync();
            console.log("[scheduler] git auto-sync:", status.lastCommit ?? "no changes");
          } catch (error) {
            console.error("[scheduler] git auto-sync failed:", error instanceof Error ? error.message : error);
          }
        }
      },
      { exclusive: true },
    );
  });
}
