import { intelligence as intelligenceSchema } from "@meos/contracts";
import { listAgents } from "@meos/core";
import type { FastifyInstance } from "fastify";
import {
  applyIntelligenceRouting,
  INTELLIGENCE_ROUTING_KEY,
  loadIntelligenceRouting,
  type AppContext,
} from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["intelligence"];

/**
 * Intelligence routing (#native-agent-intelligence). meOS runs the whole app's
 * LLM work on a SINGLE backend — the cloud API or one local coding agent — per
 * a persisted, hot-swappable setting. These two endpoints back the Settings UI:
 * GET returns the current routing + the agent picker; PUT validates, persists,
 * and re-resolves every group through {@link applyIntelligenceRouting}.
 */
export function registerIntelligenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/api/intelligence-routing",
    {
      schema: routeSchema({
        tags,
        summary: "Get intelligence routing",
        response: intelligenceSchema.IntelligenceRoutingResponse,
      }),
    },
    async () =>
      intelligenceSchema.IntelligenceRoutingResponse.parse({
        // Defaults filled, so a fresh DB returns the safe `{ backend: "api" }`.
        routing: loadIntelligenceRouting(ctx.store),
        // The full agent list (with `installed` flags) so the UI can render the
        // picker — which agents are selectable, which need installing — in one trip.
        agents: listAgents(),
      }),
  );

  app.put<{ Body: unknown }>(
    "/api/intelligence-routing",
    {
      schema: routeSchema({
        tags,
        summary: "Update intelligence routing",
        body: intelligenceSchema.UpdateIntelligenceRoutingBody,
        response: intelligenceSchema.IntelligenceRoutingResponse,
      }),
    },
    async (request) => {
      const routing = parseOrThrow(
        intelligenceSchema.UpdateIntelligenceRoutingBody,
        request.body,
        "body",
      );

      // Validate a pinned agent id against the agents meOS actually supports — a
      // typo'd id must 400, not silently fall back to Claude at resolve time.
      if (routing.agentId) {
        const knownAgents = new Set<string>(listAgents().map((a) => a.id));
        if (!knownAgents.has(routing.agentId)) {
          throw httpError.badRequest(`Unknown coding agent: ${routing.agentId}`);
        }
      }

      // Persist first, then re-resolve every group (which re-reads the setting +
      // re-detects installed agents) so the swap reflects exactly what we stored.
      ctx.store.setSetting(INTELLIGENCE_ROUTING_KEY, routing);
      await applyIntelligenceRouting(ctx);

      return intelligenceSchema.IntelligenceRoutingResponse.parse({
        routing: loadIntelligenceRouting(ctx.store),
        agents: listAgents(),
      });
    },
  );
}
