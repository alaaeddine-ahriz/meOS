import path from "node:path";
import { digest as digestSchema } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import { applyResolution, loadProfileContext, loadSchema, proposeResolution, runConsolidation } from "@meos/core";
import { commitWikiChanges, type AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";

export function registerDigestRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/digest/latest", async () => {
    const digest = ctx.store.latestDigest();
    if (!digest) {
      throw httpError.notFound("No digest generated yet");
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
  app.get<{ Querystring: { limit?: string } }>("/api/audit", async (request) => {
    const { limit } = parseOrThrow(digestSchema.AuditQuery, request.query, "query");
    return { entries: ctx.store.recentAudit(limit ?? 100) };
  });

  app.post<{ Params: { id: string }; Body: { action?: string } }>(
    "/api/contradictions/:id/resolve",
    async (request, reply) => {
      const { id } = parseOrThrow(digestSchema.ResolveContradictionParams, request.params, "params");
      const { action } = parseOrThrow(digestSchema.ResolveContradictionBody, request.body, "body");
      if (!applyResolution(ctx.store, id, action)) {
        throw httpError.notFound("No such open contradiction");
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
