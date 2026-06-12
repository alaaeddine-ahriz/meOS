import path from "node:path";
import { Cron } from "croner";
import { runConsolidation } from "@meos/core";
import type { AppContext } from "./context.js";

/** Nightly consolidation (§4.5) — queued so it never races with ingestion. */
export function startScheduler(ctx: AppContext): Cron {
  return new Cron(ctx.config.consolidation.cron, () => {
    ctx.queue.push(async () => {
      const report = await runConsolidation({
        store: ctx.store,
        llm: ctx.llm,
        wiki: ctx.wiki,
        digestDir: path.join(ctx.config.dataDir, "digests"),
      });
      console.log("[scheduler] nightly consolidation:", report);
    });
  });
}
