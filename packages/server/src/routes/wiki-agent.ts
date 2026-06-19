import { wiki, wikiAgent } from "@meos/contracts";
import { temporalTag, type EntityRow } from "@meos/core";
import type { FastifyInstance } from "fastify";
import { commitWikiChanges, type AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["wiki-agent"];

/** Cap source excerpts seeded into the agent's context, mirroring the in-app sandbox. */
const MAX_SOURCE_FILES = 60;
const MAX_SOURCE_BYTES = 4000;

/**
 * External wiki maintenance (#wiki-agent): the endpoints the `@meos/wiki-mcp` MCP
 * server proxies so a coding agent (Claude Code / Codex / Claude Desktop) can
 * drive wiki upkeep over the same files + status ledger as the in-app maintainer.
 * The agent only ever rewrites prose; facts/sources/links live in the DB and are
 * untouched, so every feature is preserved by construction.
 */
export function registerWikiAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Resolve a slug list to entities; with none, every entity that has a page on disk. */
  const entitiesForSlugs = (slugs: string[] | undefined, missing?: string[]): EntityRow[] => {
    if (slugs && slugs.length > 0) {
      const out: EntityRow[] = [];
      for (const slug of slugs) {
        const entity = ctx.store.getEntityBySlug(slug);
        if (entity) out.push(entity);
        else missing?.push(slug);
      }
      return out;
    }
    return ctx.store.listEntities().filter((e) => ctx.wiki.readPage(e) !== null);
  };

  // The work queue: pages with new facts (or never written) that warrant a page.
  // The shared status surface — both maintenance paths drain the same stale set.
  app.get(
    "/api/wiki/agent/queue",
    {
      schema: routeSchema({
        tags,
        summary: "Pages needing wiki maintenance",
        response: wikiAgent.AgentQueueResponse,
      }),
    },
    async () => {
      const pages = ctx.store
        .staleEntities()
        .filter((e) => ctx.store.entityWarrantsWikiPage(e.id))
        .map((e) => {
          const meta = ctx.store.wikiPageMeta(e.id);
          return {
            entityId: e.id,
            slug: e.slug,
            type: e.type,
            name: e.name,
            path: `wiki/${e.type}/${e.slug}.md`,
            stale: true,
            newSources: ctx.store.pendingStaleSources(e.id).length,
            quality: meta?.quality ?? null,
            updatedAt: meta?.updated_at ?? null,
            exists: meta !== undefined,
          };
        });
      return wikiAgent.AgentQueueResponse.parse({
        mode: ctx.store.getWikiMaintenanceMode(),
        pages,
      });
    },
  );

  // Everything the agent needs to write a grounded page: the facts (with their
  // verbatim source quotes), typed relationships, the exact names available for
  // [[links]], and excerpts of the entity's indexed source material.
  app.get<{ Params: { slug: string } }>(
    "/api/wiki/agent/context/:slug",
    {
      schema: routeSchema({
        tags,
        summary: "Grounding context for one page",
        params: wiki.WikiPageParams,
        response: wikiAgent.AgentContextResponse,
      }),
    },
    async (request) => {
      const { slug } = parseOrThrow(wiki.WikiPageParams, request.params, "params");
      const entity = ctx.store.getEntityBySlug(slug);
      if (!entity) throw httpError.notFound("No such entity");

      const markdown = ctx.wiki.readPage(entity);
      const facts = ctx.store.visibleObservations(entity.id).map((o) => ({
        text: o.text,
        confidence: o.confidence,
        kind: o.kind,
        when: temporalTag(o),
        sourceQuote: o.source_quote,
      }));
      const relationships = ctx.store.relationshipsFor(entity.id).map((r) => ({
        label: r.label,
        direction: r.from_entity === entity.id ? ("out" as const) : ("in" as const),
        other: r.from_entity === entity.id ? r.to_name : r.from_name,
      }));
      const sources = ctx.store
        .indexedSourcesForEntity(entity.id)
        .slice(0, MAX_SOURCE_FILES)
        .map((s) => ({
          id: s.id,
          type: s.type,
          title: s.title,
          link: s.link,
          excerpt: (s.content ?? "").slice(0, MAX_SOURCE_BYTES),
        }));

      return wikiAgent.AgentContextResponse.parse({
        entity: {
          id: entity.id,
          type: entity.type,
          name: entity.name,
          slug: entity.slug,
          summary: entity.summary,
        },
        page: {
          path: `wiki/${entity.type}/${entity.slug}.md`,
          body: markdown,
          exists: markdown !== null,
        },
        facts,
        relationships,
        linkableNames: ctx.wiki.linkableNames(),
        sources,
      });
    },
  );

  // Validate edited pages without writing — the agent's feedback loop before commit.
  app.post(
    "/api/wiki/agent/check",
    {
      schema: routeSchema({
        tags,
        summary: "Lint edited pages (no write)",
        body: wikiAgent.AgentCheckBody,
        response: wikiAgent.AgentCheckResponse,
      }),
    },
    async (request) => {
      const { slugs } = parseOrThrow(wikiAgent.AgentCheckBody, request.body ?? {}, "body");
      const results = entitiesForSlugs(slugs).map((e) => ({
        ...ctx.wiki.checkPage(e),
        exists: ctx.wiki.readPage(e) !== null,
      }));
      return wikiAgent.AgentCheckResponse.parse({ results });
    },
  );

  // Whole-body write for agents without filesystem access (e.g. Claude Desktop).
  // Imposes system frontmatter, writes the file, returns a check — does NOT commit.
  app.post(
    "/api/wiki/agent/write",
    {
      schema: routeSchema({
        tags,
        summary: "Write a page body to disk",
        body: wikiAgent.AgentWriteBody,
        response: wikiAgent.AgentWriteResponse,
      }),
    },
    async (request) => {
      const { slug, body } = parseOrThrow(wikiAgent.AgentWriteBody, request.body, "body");
      const entity = ctx.store.getEntityBySlug(slug);
      if (!entity) throw httpError.notFound("No such entity");
      const path = ctx.wiki.stageBody(entity, body);
      return wikiAgent.AgentWriteResponse.parse({
        slug,
        path,
        written: true,
        check: { ...ctx.wiki.checkPage(entity), exists: true },
      });
    },
  );

  // Reconcile edited pages into the knowledge store + git. Idempotent: a page
  // whose body is unchanged is skipped, so the agent and the in-app path never
  // reprocess each other's output. With no slugs, drains the stale queue.
  app.post(
    "/api/wiki/agent/commit",
    {
      schema: routeSchema({
        tags,
        summary: "Commit edited pages",
        body: wikiAgent.AgentCommitBody,
        response: wikiAgent.AgentCommitResponse,
      }),
    },
    async (request) => {
      const { slugs, message } = parseOrThrow(
        wikiAgent.AgentCommitBody,
        request.body ?? {},
        "body",
      );
      const missing: string[] = [];
      const entities =
        slugs && slugs.length > 0
          ? entitiesForSlugs(slugs, missing)
          : ctx.store.staleEntities().filter((e) => ctx.store.entityWarrantsWikiPage(e.id));

      const committed: Array<{ slug: string; kind: "created" | "updated"; quality: number }> = [];
      const skipped: Array<{ slug: string; reason: string }> = missing.map((slug) => ({
        slug,
        reason: "not-found",
      }));
      const changes = [];
      for (const entity of entities) {
        const result = await ctx.wiki.reconcileFromDisk(entity, { authoredBy: "agent" });
        if (result.change) {
          changes.push(result.change);
          committed.push({
            slug: entity.slug,
            kind: result.change.kind,
            quality: result.check.quality,
          });
        } else if (result.skipped) {
          skipped.push({ slug: entity.slug, reason: result.skipped });
        }
      }

      if (changes.length > 0) {
        await commitWikiChanges(ctx, changes, message ?? "Wiki update (agent)");
      }
      const hash = changes.length > 0 ? await ctx.git.headHash() : null;
      return wikiAgent.AgentCommitResponse.parse({ committed, skipped, git: { hash } });
    },
  );

  app.get(
    "/api/wiki/agent/mode",
    {
      schema: routeSchema({
        tags,
        summary: "Get wiki maintenance mode",
        response: wikiAgent.AgentModeResponse,
      }),
    },
    async () => wikiAgent.AgentModeResponse.parse({ mode: ctx.store.getWikiMaintenanceMode() }),
  );

  app.put(
    "/api/wiki/agent/mode",
    {
      schema: routeSchema({
        tags,
        summary: "Set wiki maintenance mode",
        body: wikiAgent.AgentModeBody,
        response: wikiAgent.AgentModeResponse,
      }),
    },
    async (request) => {
      const { mode } = parseOrThrow(wikiAgent.AgentModeBody, request.body, "body");
      ctx.store.setWikiMaintenanceMode(mode);
      return wikiAgent.AgentModeResponse.parse({ mode });
    },
  );
}
