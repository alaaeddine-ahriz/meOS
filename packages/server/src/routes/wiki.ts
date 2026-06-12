import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function registerWikiRoutes(app: FastifyInstance, ctx: AppContext): void {
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
      observations: ctx.store.activeObservations(entity.id).map((o) => ({
        text: o.text,
        confidence: o.confidence,
        tier: o.tier,
        recordedAt: o.created_at,
        lastConfirmedAt: o.last_confirmed_at,
      })),
    };
  });
}
