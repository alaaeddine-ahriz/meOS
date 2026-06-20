import type { FastifySchema } from "fastify";
import { z } from "zod";

/**
 * Convert a Zod schema (zod v4) into the JSON Schema shape Fastify/Swagger
 * expects. Draft-7 is what `@fastify/swagger` consumes, and it matches how the
 * shared `ErrorEnvelope` component is registered in {@link registerOpenApi}.
 */
function toJson(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

/**
 * A `$ref` to the single shared error envelope schema registered with
 * `app.addSchema({ $id: "ErrorEnvelope" })` in {@link registerOpenApi}. The
 * `Id#` form resolves both in Fastify's response serializer and in the OpenAPI
 * spec (where swagger's refResolver maps it to `components/schemas/ErrorEnvelope`).
 */
const errorRef = { $ref: "ErrorEnvelope#" } as const;

/**
 * The error responses every route can produce: the error handler turns any
 * thrown {@link ApiError}/validation/uncaught error into the one envelope, so we
 * document the common 4xx/5xx codes pointing at the shared component. Listing
 * 400/404/409/500 on every route is intentionally generous — it documents the
 * envelope contract rather than asserting each route emits every status.
 */
const errorResponses = {
  400: errorRef,
  404: errorRef,
  409: errorRef,
  500: errorRef,
} as const;

/**
 * How dangerous a route is to call blind, used to gate auto-exposure over MCP.
 * A coding agent calling generated tools needs this to reason about consent:
 *  - `"read"`   — pure reads (GET-like): always safe to expose and auto-call.
 *  - `"write"`  — creates/updates state but is reversible/idempotent enough to
 *                 expose; the agent should still narrate what it's doing.
 *  - `"destructive"` — irreversible (deletes, merges, resets). NEVER auto-exposed
 *                 by the manifest (see {@link buildToolManifest}); a later, explicitly
 *                 human-gated surface can opt these in, but the generated projection
 *                 deliberately omits them so an agent can't quietly destroy data.
 */
export type McpSafety = "read" | "write" | "destructive";

/**
 * Opt-in MCP annotation for a route. The MCP surface is a GENERATED projection of
 * the annotated HTTP API: a route is exposed as an agent-callable tool ONLY when
 * it sets `expose: true` here — callers opt in, nothing is exposed by default. The
 * resolved value is attached to the Fastify schema as the `x-mcp` vendor extension
 * (see {@link routeSchema}), where the manifest builder's `onRoute` hook reads it.
 */
export interface RouteMcpAnnotation {
  /** Expose this route as a generated MCP tool. Omitted/false ⇒ not exposed. */
  expose?: boolean;
  /**
   * Override the derived tool name (e.g. `"wiki_list"`). Omit to let the manifest
   * derive a stable name from the method + path (POST /api/vault/note → `vault_note_create`).
   */
  name?: string;
  /** Danger class gating auto-exposure; `"destructive"` is never auto-exposed. */
  safety?: McpSafety;
}

/** The `x-mcp` vendor-extension key carrying the resolved {@link RouteMcpAnnotation}. */
export const MCP_EXTENSION_KEY = "x-mcp" as const;

export interface RouteSchemaParts {
  /** OpenAPI tag(s) grouping this route in the docs. */
  tags?: string[];
  /** One-line human summary shown in the docs UI. */
  summary?: string;
  /** Zod schema for the JSON request body. */
  body?: z.ZodType;
  /** Zod schema for the query string. */
  querystring?: z.ZodType;
  /** Zod schema for the path params. */
  params?: z.ZodType;
  /**
   * Zod schema(s) for success responses, keyed by status code. A bare schema is
   * treated as the 200 response.
   */
  response?: z.ZodType | Partial<Record<number, z.ZodType>>;
  /**
   * Opt-in MCP exposure for this route. Omit to keep the route OFF the generated
   * MCP surface (the default policy is "not exposed"). A route joins the surface
   * only by explicitly setting `{ expose: true, safety }`; `safety: "destructive"`
   * is recorded but still filtered out of the auto-generated manifest.
   */
  mcp?: RouteMcpAnnotation;
}

/**
 * A Fastify schema augmented with the resolved `x-mcp` vendor extension. Fastify
 * and `@fastify/swagger` pass unknown `x-` keys through untouched — into both the
 * route's `onRoute` `routeOptions.schema` (where the manifest hook reads it) and
 * the emitted `/api/openapi.json` (where it self-documents the MCP surface) — so a
 * single annotation drives both without a parallel registry.
 */
export type FastifySchemaWithMcp = FastifySchema & {
  [MCP_EXTENSION_KEY]?: RouteMcpAnnotation;
};

/**
 * Build a Fastify `schema` object from contract Zod schemas so `/api/openapi.json`
 * documents the real request/response shapes. Success responses are taken from
 * `@meos/contracts`; the shared error envelope is attached to every route via a
 * `$ref`, keeping the documented error model in lockstep with the contracts
 * package. Attaching JSON schema (rather than switching Fastify to a full zod
 * type-provider) is enough to satisfy "OpenAPI generated from schemas" while
 * leaving request validation to the handlers' `parseOrThrow` calls.
 *
 * When a route opts into MCP via `mcp`, the resolved annotation is attached as the
 * `x-mcp` vendor extension. Fastify keeps unknown `x-` keys on the schema, so the
 * same object reaches the manifest's `onRoute` hook (which derives the tool) and
 * the OpenAPI spec (where it documents the MCP surface) — one annotation, two
 * consumers, no parallel bookkeeping.
 */
export function routeSchema(parts: RouteSchemaParts): FastifySchemaWithMcp {
  const schema: FastifySchemaWithMcp = {};
  if (parts.tags) schema.tags = parts.tags;
  if (parts.summary) schema.summary = parts.summary;
  if (parts.body) schema.body = toJson(parts.body);
  if (parts.querystring) schema.querystring = toJson(parts.querystring);
  if (parts.params) schema.params = toJson(parts.params);

  const response: Record<string | number, unknown> = { ...errorResponses };
  if (parts.response) {
    if (parts.response instanceof z.ZodType) {
      response[200] = toJson(parts.response);
    } else {
      for (const [status, zodSchema] of Object.entries(parts.response)) {
        if (zodSchema) response[Number(status)] = toJson(zodSchema);
      }
    }
  }
  schema.response = response;

  // Carry the opt-in MCP annotation through as a vendor extension. Only routes
  // that explicitly set `mcp` are annotated; everything else stays off the
  // generated MCP surface by default.
  if (parts.mcp) schema[MCP_EXTENSION_KEY] = parts.mcp;

  return schema;
}
