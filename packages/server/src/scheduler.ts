import path from "node:path";
import { Cron } from "croner";
import {
  createLogger,
  IngestPriority,
  loadProfileContext,
  loadSchema,
  runConsolidation,
} from "@meos/core";
import { commitWikiChanges, type AppContext } from "./context.js";

const log = createLogger("scheduler");

/** Nightly consolidation (§4.5) — queued so it never races with ingestion. */
export function startScheduler(ctx: AppContext): Cron {
  return new Cron(ctx.config.consolidation.cron, () => {
    ctx.queue.push(
      async () => {
        await ctx.events.emit("onSchedule", { reason: "cron" });
        const report = await runConsolidation({
          store: ctx.store,
          llm: ctx.llm,
          wiki: ctx.wiki,
          embedder: ctx.embedder,
          schema: loadSchema(ctx.config.dataDir),
          profile: loadProfileContext(ctx.config.dataDir),
          digestDir: path.join(ctx.config.dataDir, "digests"),
        });
        const { wikiChanges, ...summary } = report;
        log.info(summary, "nightly consolidation");

        // Commit the night's regenerated pages + digest locally with a message.
        await commitWikiChanges(ctx, wikiChanges, "Nightly consolidation", [
          `digests/${report.digestDate}.md`,
        ]);

        // Push the night's wiki/digest changes to the remote when the user
        // opted in. Failures (e.g. auth, offline) are logged, never fatal.
        if (ctx.store.getSetting<{ autoSync?: boolean }>("git")?.autoSync) {
          try {
            const status = await ctx.git.sync();
            log.info({ lastCommit: status.lastCommit ?? null }, "git auto-sync");
          } catch (error) {
            log.error({ err: error }, "git auto-sync failed");
          }
        }
      },
      // Nightly maintenance is the lowest priority class (#18) and exclusive, so
      // it never starves user/watch/connector work and runs alone when it does.
      { exclusive: true, priority: IngestPriority.NIGHTLY },
    );
  });
}
