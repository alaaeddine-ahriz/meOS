import { wiki } from "@meos/contracts";
import { CONFIDENCE_CAP, findDuplicateEntities, isStale, temporalTag } from "@meos/core";
import type { FastifyInstance } from "fastify";
import { commitWikiChanges, type AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["wiki"];

export function registerWikiRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Likely-duplicate entities (human-gated dedup): detection only — the user
  // confirms a merge, which is destructive, via POST /api/entities/merge.
  app.get(
    "/api/entities/duplicates",
    {
      schema: routeSchema({
        tags,
        summary: "Likely-duplicate entities",
        response: wiki.DuplicatesResponse,
      }),
    },
    async () => wiki.DuplicatesResponse.parse({ duplicates: findDuplicateEntities(ctx.store) }),
  );

  app.post(
    "/api/entities/merge",
    {
      schema: routeSchema({
        tags,
        summary: "Merge two entities",
        body: wiki.MergeEntitiesBody,
        response: wiki.MergeEntitiesResponse,
      }),
    },
    async (request, reply) => {
      const { loserId, winnerId } = parseOrThrow(wiki.MergeEntitiesBody, request.body, "body");
      if (!ctx.store.mergeEntities(loserId, winnerId)) {
        throw httpError.badRequest("Merge failed (unknown entity or self-merge)");
      }
      // The survivor's page needs rewriting around the merged knowledge.
      ctx.queue.push(async () => {
        const changes = await ctx.wiki.regenerateStale();
        await commitWikiChanges(ctx, changes, "Entity merge");
      });
      return reply.send(wiki.MergeEntitiesResponse.parse({ merged: true }));
    },
  );

  // The "no" branch of dedup: remember a rejected pair so it stops resurfacing.
  app.post(
    "/api/entities/dismiss-duplicate",
    {
      schema: routeSchema({
        tags,
        summary: "Dismiss a duplicate pair",
        body: wiki.DismissDuplicateBody,
        response: wiki.DismissDuplicateResponse,
      }),
    },
    async (request, reply) => {
      const { aId, bId } = parseOrThrow(wiki.DismissDuplicateBody, request.body, "body");
      if (!ctx.store.dismissDuplicate(aId, bId)) {
        throw httpError.badRequest("Dismiss failed (a pair must be two distinct entities)");
      }
      return reply.send(wiki.DismissDuplicateResponse.parse({ dismissed: true }));
    },
  );

  // Rebuild the compiled-prose retrieval index from pages on disk (no LLM), and
  // prune pages that no longer warrant one (connector-only / private-only people).
  app.post(
    "/api/jobs/backfill-wiki",
    {
      schema: routeSchema({
        tags,
        summary: "Rebuild the wiki retrieval index",
        response: { 202: wiki.BackfillWikiResponse },
      }),
    },
    async (_request, reply) => {
      ctx.queue.push(async () => {
        const pruned = ctx.wiki.pruneConnectorOnlyPages();
        const filled = await ctx.wiki.backfillPages();
        app.log.info({ filled, pruned }, "wiki backfill finished");
      });
      return reply.code(202).send(wiki.BackfillWikiResponse.parse({ started: true }));
    },
  );

  // The wiki index/graph only lists entities that actually have a page: people
  // known only from a connector (contact/email/calendar) stay searchable but are
  // kept out of the wiki so they don't add noise (they'd 404 anyway).
  app.get(
    "/api/wiki",
    {
      schema: routeSchema({
        tags,
        summary: "List wiki entities",
        response: wiki.ListEntitiesResponse,
      }),
    },
    async () => {
      const withPages = ctx.store.wikiPageEntityIds();
      return wiki.ListEntitiesResponse.parse({
        entities: ctx.store
          .listEntities()
          .filter((entity) => withPages.has(entity.id))
          .map((entity) => ({
            id: entity.id,
            type: entity.type,
            name: entity.name,
            slug: entity.slug,
            summary: entity.summary,
            updatedAt: entity.updated_at,
          })),
      });
    },
  );

  app.get(
    "/api/wiki/graph",
    {
      schema: routeSchema({ tags, summary: "Wiki entity graph", response: wiki.WikiGraphResponse }),
    },
    async () => {
      const withPages = ctx.store.wikiPageEntityIds();
      // Per-edge provenance loaded once (#89): a representative source id to open
      // the evidence behind a link, and the distinct-source count that drives the
      // confirmed-vs-generated idiom.
      const sourceStats = ctx.store.relationshipSourceStats();
      return wiki.WikiGraphResponse.parse({
        nodes: ctx.store
          .listEntities()
          .filter((entity) => withPages.has(entity.id))
          .map((entity) => ({
            id: entity.id,
            type: entity.type,
            name: entity.name,
            slug: entity.slug,
            // Powers the focus/inspect panel without a second round-trip.
            summary: entity.summary,
          })),
        // Drop edges to a hidden (pageless) endpoint so the graph has no dangling links.
        links: ctx.store
          .allRelationships()
          .filter((r) => withPages.has(r.from_entity) && withPages.has(r.to_entity))
          .map((r) => {
            const stats = sourceStats.get(r.id);
            const sourceCount = stats?.sourceCount ?? 0;
            return {
              from: r.from_entity,
              to: r.to_entity,
              label: r.label,
              confidence: r.confidence,
              sourceId: stats?.sourceId ?? null,
              sourceCount,
              // PROXY for user-confirmed (no confirmation column exists, #89): an
              // edge corroborated by more than one distinct source, or pinned at
              // the reinforcement cap, is shown as confirmed/solid; otherwise it's
              // a single-shot generated guess shown dashed.
              confirmed: sourceCount > 1 || r.confidence >= CONFIDENCE_CAP,
            };
          }),
      });
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/api/wiki/:slug",
    {
      schema: routeSchema({
        tags,
        summary: "Get a wiki page",
        params: wiki.WikiPageParams,
        response: wiki.WikiPageResponse,
      }),
    },
    async (request) => {
      const { slug } = parseOrThrow(wiki.WikiPageParams, request.params, "params");
      const entity = ctx.store.getEntityBySlug(slug);
      if (!entity) {
        throw httpError.notFound("No such wiki page");
      }
      const markdown = ctx.wiki.readPage(entity);
      const relationships = ctx.store.relationshipsFor(entity.id).map((r) => ({
        label: r.label,
        direction: r.from_entity === entity.id ? "out" : "in",
        other: r.from_entity === entity.id ? r.to_name : r.from_name,
      }));
      return wiki.WikiPageResponse.parse({
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
        observations: (() => {
          // Facts whose only backing revision is no longer current (#16) — flagged
          // so the UI can show them as outdated-source rather than equally live.
          const staleBacking = ctx.store.staleBackingByEntity(entity.id);
          return ctx.store.activeObservations(entity.id).map((o) => ({
            text: o.text,
            confidence: o.confidence,
            tier: o.tier,
            recordedAt: o.created_at,
            lastConfirmedAt: o.last_confirmed_at,
            // Recency surfaced to the UI: the same date/stale/upcoming tag the chat
            // model sees, so the user judges a fact's pertinence the same way.
            when: temporalTag(o),
            stale: isStale(o),
            sourceStatus: staleBacking.get(o.id) ?? null,
          }));
        })(),
      });
    },
  );
}
