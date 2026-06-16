import { runtime } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { routeSchema } from "../route-schema.js";

const tags = ["runtime"];

/**
 * GET /api/runtime — a read-only snapshot of every background worker's health
 * (watcher, connectors, scheduler, ingest + wiki queues). Lets the UI show
 * whether ingestion, connectors, the scheduler, and wiki regeneration are
 * healthy without coupling to their internals. Validated against the public
 * contract so the shape can't drift from the client's expectations.
 */
export function registerRuntimeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/api/runtime",
    {
      schema: routeSchema({
        tags,
        summary: "Runtime worker health",
        response: runtime.RuntimeHealthSchema,
      }),
    },
    async () => runtime.RuntimeHealthSchema.parse({ workers: ctx.workers.health() }),
  );
}
