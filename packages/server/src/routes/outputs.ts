import type { FastifyInstance } from "fastify";
import {
  contradictionReport,
  decisionBrief,
  dependencyGraph,
  entityTimeline,
  meetingBrief,
} from "@meos/core";
import type { AppContext } from "../context.js";

/**
 * Output modes: project the knowledge base into the artifacts a consultant or
 * director hands over — decision briefs, timelines, dependency graphs,
 * contradiction reports, meeting prep. Each returns portable Markdown; ?format=json
 * wraps it for programmatic export.
 */
export function registerOutputRoutes(app: FastifyInstance, ctx: AppContext): void {
  const reply = (markdown: string, format: string | undefined) =>
    format === "json" ? { markdown } : markdown;

  app.get<{ Querystring: { format?: string } }>("/api/outputs/decision-brief", async (request) =>
    reply(decisionBrief(ctx.store), request.query.format),
  );

  app.get<{ Querystring: { format?: string } }>(
    "/api/outputs/contradiction-report",
    async (request) => reply(contradictionReport(ctx.store), request.query.format),
  );

  const entityResolver = (key: string): number | undefined => {
    const asId = Number(key);
    if (Number.isInteger(asId) && asId > 0) return ctx.store.getEntity(asId)?.id;
    return ctx.store.findEntityByName(key)?.id ?? ctx.store.getEntityBySlug(key)?.id;
  };

  for (const [path, fn] of [
    ["timeline", entityTimeline],
    ["dependency-graph", dependencyGraph],
    ["meeting-brief", meetingBrief],
  ] as const) {
    app.get<{ Querystring: { entity?: string; format?: string } }>(
      `/api/outputs/${path}`,
      async (request, res) => {
        const key = request.query.entity?.trim();
        if (!key)
          return res
            .code(400)
            .send({ error: "Query parameter 'entity' is required (id, name, or slug)" });
        const entityId = entityResolver(key);
        if (entityId === undefined)
          return res.code(404).send({ error: `No entity matching "${key}"` });
        return reply(fn(ctx.store, entityId), request.query.format);
      },
    );
  }
}
