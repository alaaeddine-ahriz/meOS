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
}

/**
 * Build a Fastify `schema` object from contract Zod schemas so `/api/openapi.json`
 * documents the real request/response shapes. Success responses are taken from
 * `@meos/contracts`; the shared error envelope is attached to every route via a
 * `$ref`, keeping the documented error model in lockstep with the contracts
 * package. Attaching JSON schema (rather than switching Fastify to a full zod
 * type-provider) is enough to satisfy "OpenAPI generated from schemas" while
 * leaving request validation to the handlers' `parseOrThrow` calls.
 */
export function routeSchema(parts: RouteSchemaParts): FastifySchema {
  const schema: FastifySchema = {};
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

  return schema;
}
