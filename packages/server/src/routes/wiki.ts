import { findDuplicateEntities, isStale, temporalTag } from "@meos/core";
import type { FastifyInstance } from "fastify";
import { commitWikiChanges, type AppContext } from "../context.js";

export function registerWikiRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Likely-duplicate entities (human-gated dedup): detection only — the user
  // confirms a merge, which is destructive, via POST /api/entities/merge.
  app.get("/api/entities/duplicates", async () => ({
    duplicates: findDuplicateEntities(ctx.store),
  }));

  app.post<{ Body: { loserId?: number; winnerId?: number } }>(
    "/api/entities/merge",
    async (request, reply) => {
      const { loserId, winnerId } = request.body ?? {};
      if (typeof loserId !== "number" || typeof winnerId !== "number") {
        return reply
          .code(400)
          .send({ error: "Fields 'loserId' and 'winnerId' (numbers) are required" });
      }
      if (!ctx.store.mergeEntities(loserId, winnerId)) {
        return reply.code(400).send({ error: "Merge failed (unknown entity or self-merge)" });
      }
      // The survivor's page needs rewriting around the merged knowledge.
      ctx.queue.push(async () => {
        const changes = await ctx.wiki.regenerateStale();
        await commitWikiChanges(ctx, changes, "Entity merge");
      });
      return reply.send({ merged: true });
    },
  );

  // The "no" branch of dedup: remember a rejected pair so it stops resurfacing.
  app.post<{ Body: { aId?: number; bId?: number } }>(
    "/api/entities/dismiss-duplicate",
    async (request, reply) => {
      const { aId, bId } = request.body ?? {};
      if (typeof aId !== "number" || typeof bId !== "number") {
        return reply.code(400).send({ error: "Fields 'aId' and 'bId' (numbers) are required" });
      }
      if (!ctx.store.dismissDuplicate(aId, bId)) {
        return reply
          .code(400)
          .send({ error: "Dismiss failed (a pair must be two distinct entities)" });
      }
      return reply.send({ dismissed: true });
    },
  );

  // Rebuild the compiled-prose retrieval index from pages on disk (no LLM).
  app.post("/api/jobs/backfill-wiki", async (_request, reply) => {
    ctx.queue.push(async () => {
      const filled = await ctx.wiki.backfillPages();
      app.log.info({ filled }, "wiki backfill finished");
    });
    return reply.code(202).send({ started: true });
  });

  app.get("/api/wiki", async () => ({
    entities: ctx.store.listEntities().map((entity) => ({
      id: entity.id,
      type: entity.type,
      name: entity.name,
      slug: entity.slug,
      summary: entity.summary,
      updatedAt: entity.updated_at,
    })),
  }));

  app.get("/api/wiki/graph", async () => ({
    nodes: ctx.store.listEntities().map((entity) => ({
      id: entity.id,
      type: entity.type,
      name: entity.name,
      slug: entity.slug,
    })),
    links: ctx.store.allRelationships().map((r) => ({
      from: r.from_entity,
      to: r.to_entity,
      label: r.label,
    })),
  }));

  app.get<{ Params: { slug: string } }>("/api/wiki/:slug", async (request, reply) => {
    const entity = ctx.store.getEntityBySlug(request.params.slug);
    if (!entity) {
      return reply.code(404).send({ error: "No such wiki page" });
    }
    const markdown = ctx.wiki.readPage(entity);
    const relationships = ctx.store.relationshipsFor(entity.id).map((r) => ({
      label: r.label,
      direction: r.from_entity === entity.id ? "out" : "in",
      other: r.from_entity === entity.id ? r.to_name : r.from_name,
    }));
    return {
      entity: {
        id: entity.id,
        type: entity.type,
        name: entity.name,
        slug: entity.slug,
        summary: entity.summary,
        stale: entity.wiki_stale === 1,
        updatedAt: entity.updated_at,
      },
      markdown,
      relationships,
      sources: ctx.store.sourcesForEntity(entity.id),
      observations: ctx.store.activeObservations(entity.id).map((o) => ({
        text: o.text,
        confidence: o.confidence,
        tier: o.tier,
        recordedAt: o.created_at,
        lastConfirmedAt: o.last_confirmed_at,
        // Recency surfaced to the UI: the same date/stale/upcoming tag the chat
        // model sees, so the user judges a fact's pertinence the same way.
        when: temporalTag(o),
        stale: isStale(o),
      })),
    };
  });
}
