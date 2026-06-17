import { NumericIdParam, sources } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["sources"];

/**
 * The Sources tab (#goal): browse every locally-indexed connector item — a
 * contact, calendar event, task, or email — as its own first-class entity, with
 * a deep link to open the original and links to the wiki entities and sibling
 * items it connects to. Read-only; the items are produced by the connector sync.
 */
export function registerSourceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/api/sources",
    {
      schema: routeSchema({
        tags,
        summary: "List locally-indexed connector items",
        response: sources.ListSourcesResponse,
      }),
    },
    async () => sources.ListSourcesResponse.parse({ sources: ctx.store.listIndexedSources() }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/sources/:id",
    {
      schema: routeSchema({
        tags,
        summary: "One indexed item with its links",
        params: NumericIdParam,
        response: sources.SourceDetailResponse,
      }),
    },
    async (request) => {
      const { id } = parseOrThrow(NumericIdParam, request.params, "params");
      const detail = ctx.store.getIndexedSource(id);
      if (!detail) {
        throw httpError.notFound("No such indexed source");
      }
      return sources.SourceDetailResponse.parse(detail);
    },
  );
}
