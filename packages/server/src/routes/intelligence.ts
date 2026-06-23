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
  // Both handlers return the same payload: the current routing plus the agent
  // picker. `routing` defaults are filled, so a fresh DB yields the safe
  // `{ backend: "api" }`; `agents` is the full list (with `installed` flags) so
  // the UI can render the picker — selectable vs. needs-installing — in one trip.
  const currentRouting = () =>
    intelligenceSchema.IntelligenceRoutingResponse.parse({
      routing: loadIntelligenceRouting(ctx.store),
      agents: listAgents(),
    });

  app.get(
    "/api/intelligence-routing",
    {
      schema: routeSchema({
        tags,
        summary: "Get intelligence routing",
        response: intelligenceSchema.IntelligenceRoutingResponse,
      }),
    },
    async () => currentRouting(),
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
      if (routing.agentId && !listAgents().some((a) => a.id === routing.agentId)) {
        throw httpError.badRequest(`Unknown coding agent: ${routing.agentId}`);
      }

      // Persist first, then re-resolve every group (which re-reads the setting +
      // re-detects installed agents) so the swap reflects exactly what we stored.
      ctx.store.setSetting(INTELLIGENCE_ROUTING_KEY, routing);
      await applyIntelligenceRouting(ctx);

      // Switching the backend is a deliberate choice of a (hopefully working)
      // intelligence path, exactly like changing the cloud provider/key — so drop
      // any provider hold (#circuit) and let the stalled backlog drain on the new
      // backend. Without this, a hold engaged by a dead API key (e.g. out of
      // credits) keeps ingestion frozen even after switching to a local agent,
      // because the hold's auto-recovery probe is cloud-only and never succeeds.
      // No-op when nothing is held; if the new backend is also broken it re-trips.
      ctx.durableIngest.clearProviderHold();

      return currentRouting();
    },
  );
}
