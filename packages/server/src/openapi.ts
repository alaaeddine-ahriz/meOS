import { ErrorEnvelopeSchema } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { z } from "zod";

/**
 * Expose an OpenAPI 3 spec generated from the route schemas at
 * `/api/openapi.json`, plus a browsable UI at `/api/docs`.
 *
 * The error envelope is registered as a shared component every error response
 * references, so the documented error model stays in lockstep with
 * `@meos/contracts`. Routes opt into richer per-endpoint documentation by
 * setting a JSON `schema` in their Fastify options; this baseline guarantees the
 * spec is always available and always documents the single error shape.
 */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "meOS API",
        description:
          "The meOS local server API. Request/response shapes are defined in @meos/contracts (Zod). All errors share one envelope (see components/schemas/ErrorEnvelope).",
        version: "0.1.0",
      },
      components: {
        schemas: {
          ErrorEnvelope: z.toJSONSchema(ErrorEnvelopeSchema, { target: "draft-7" }) as Record<string, unknown>,
        },
      },
      tags: [
        { name: "ingest", description: "Document ingestion + inbox" },
        { name: "wiki", description: "Compiled knowledge pages, graph, dedup" },
        { name: "vault", description: "Hand-authored note vault" },
        { name: "chat", description: "Conversational retrieval (SSE)" },
        { name: "activity", description: "Wiki-maintainer run transcripts (SSE)" },
        { name: "digest", description: "Consolidation, contradictions, audit" },
        { name: "outputs", description: "Projected artifacts (briefs, timelines)" },
        { name: "profile", description: "The user-lens profile" },
        { name: "settings", description: "LLM, folders, git settings" },
        { name: "connectors", description: "Google Contacts/Calendar/Gmail" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/api/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
  });
}
