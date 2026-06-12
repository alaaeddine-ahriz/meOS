import path from "node:path";
import type { FastifyInstance } from "fastify";
import { runConsolidation } from "@meos/core";
import type { AppContext } from "../context.js";

export function registerDigestRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/digest/latest", async (_request, reply) => {
    const digest = ctx.store.latestDigest();
    if (!digest) {
      return reply.code(404).send({ error: "No digest generated yet" });
    }
    return digest;
  });

  app.post("/api/jobs/consolidate", async (_request, reply) => {
    ctx.queue.push(async () => {
      const report = await runConsolidation({
        store: ctx.store,
        llm: ctx.llm,
        wiki: ctx.wiki,
        digestDir: path.join(ctx.config.dataDir, "digests"),
      });
      app.log.info({ report }, "consolidation finished");
    });
    return reply.code(202).send({ started: true });
  });

  app.get("/api/contradictions", async () => ({
    contradictions: ctx.store.unresolvedContradictions(),
  }));
}
