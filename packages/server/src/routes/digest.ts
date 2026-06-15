import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  applyResolution,
  loadProfileContext,
  loadSchema,
  proposeResolution,
  runConsolidation,
  type ResolutionAction,
} from "@meos/core";
import { commitWikiChanges, type AppContext } from "../context.js";

const RESOLUTION_ACTIONS = new Set<ResolutionAction>([
  "supersede_a",
  "supersede_b",
  "keep_both",
  "context_specific",
]);

export function registerDigestRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/digest/latest", async (_request, reply) => {
    const digest = ctx.store.latestDigest();
    if (!digest) {
      return reply.code(404).send({ error: "No digest generated yet" });
    }
    return digest;
  });

  app.post("/api/jobs/consolidate", async (_request, reply) => {
    ctx.queue.push(
      async () => {
        const report = await runConsolidation({
          store: ctx.store,
          llm: ctx.llm,
          wiki: ctx.wiki,
          embedder: ctx.embedder,
          schema: loadSchema(ctx.config.dataDir),
          profile: loadProfileContext(ctx.config.dataDir),
          digestDir: path.join(ctx.config.dataDir, "digests"),
        });
        await commitWikiChanges(ctx, report.wikiChanges, "Consolidation", [
          `digests/${report.digestDate}.md`,
        ]);
        const { wikiChanges, ...summary } = report;
        app.log.info({ report: summary }, "consolidation finished");
      },
      { exclusive: true },
    );
    return reply.code(202).send({ started: true });
  });

  // Each open contradiction carries a proposed resolution (recency / source
  // authority / confidence / corroboration) the user can accept or override.
  app.get("/api/contradictions", async () => ({
    contradictions: ctx.store.unresolvedContradictions().map((c) => ({
      ...c,
      proposal: proposeResolution(ctx.store, c.id),
    })),
  }));

  // Governance: the append-only audit trail of automated memory operations.
  app.get<{ Querystring: { limit?: string } }>("/api/audit", async (request) => ({
    entries: ctx.store.recentAudit(Number(request.query.limit) || 100),
  }));

  app.post<{ Params: { id: string }; Body: { action?: ResolutionAction } }>(
    "/api/contradictions/:id/resolve",
    async (request, reply) => {
      const id = Number(request.params.id);
      const action = request.body?.action;
      if (!action || !RESOLUTION_ACTIONS.has(action)) {
        return reply.code(400).send({
          error:
            "Field 'action' must be one of supersede_a, supersede_b, keep_both, context_specific",
        });
      }
      if (!applyResolution(ctx.store, id, action)) {
        return reply.code(404).send({ error: "No such open contradiction" });
      }
      // The resolution may have retired a claim; refresh the affected page.
      ctx.queue.push(async () => {
        const changes = await ctx.wiki.regenerateStale();
        await commitWikiChanges(ctx, changes, "Contradiction resolved");
      });
      return reply.send({ resolved: true });
    },
  );
}
