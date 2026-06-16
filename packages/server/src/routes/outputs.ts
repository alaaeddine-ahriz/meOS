import type { FastifyInstance } from "fastify";
import {
  contradictionReport,
  decisionBrief,
  dependencyGraph,
  entityTimeline,
  meetingBrief,
} from "@meos/core";
import { outputs as outputsSchema } from "@meos/contracts";
import type { AppContext } from "../context.js";
import { httpError } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["outputs"];

/**
 * Output modes: project the knowledge base into the artifacts a consultant or
 * director hands over — decision briefs, timelines, dependency graphs,
 * contradiction reports, meeting prep. Each returns portable Markdown; ?format=json
 * wraps it for programmatic export.
 */
export function registerOutputRoutes(app: FastifyInstance, ctx: AppContext): void {
  const reply = (markdown: string, format: string | undefined) =>
    format === "json" ? { markdown } : markdown;

  app.get<{ Querystring: { format?: string } }>(
    "/api/outputs/decision-brief",
    {
      schema: routeSchema({
        tags,
        summary: "Decision brief output",
        querystring: outputsSchema.OutputQuery,
      }),
    },
    async (request) => reply(decisionBrief(ctx.store), request.query.format),
  );

  app.get<{ Querystring: { format?: string } }>(
    "/api/outputs/contradiction-report",
    {
      schema: routeSchema({
        tags,
        summary: "Contradiction report output",
        querystring: outputsSchema.OutputQuery,
      }),
    },
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
      {
        schema: routeSchema({
          tags,
          summary: `${path} output`,
          querystring: outputsSchema.OutputQuery,
        }),
      },
      async (request) => {
        const key = request.query.entity?.trim();
        if (!key)
          throw httpError.validation("Query parameter 'entity' is required (id, name, or slug)");
        const entityId = entityResolver(key);
        if (entityId === undefined) throw httpError.notFound(`No entity matching "${key}"`);
        return reply(fn(ctx.store, entityId), request.query.format);
      },
    );
  }
}
