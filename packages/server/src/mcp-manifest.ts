import type { FastifyInstance, RouteOptions } from "fastify";
import type { agentTools } from "@meos/contracts";
import { MCP_EXTENSION_KEY, type McpSafety, type RouteMcpAnnotation } from "./route-schema.js";

/**
 * The server-side half of the GENERATED MCP surface.
 *
 * The MCP tools an external coding agent can call are NOT hand-authored: they are
 * a projection of the annotated HTTP API. Each route opts in with
 * `routeSchema({ mcp: { expose: true, safety } })`, which lands the annotation on
 * the Fastify schema as the `x-mcp` vendor extension. The {@link McpManifest}'s
 * `onRoute` hook (registered early in `buildServer`) reads that extension as every
 * route registers and records one manifest entry per exposed, non-destructive
 * route. `GET /api/agent/tool-manifest` then serves the collected entries, and the
 * wiki-mcp generator turns each into a live MCP tool. One annotation, no parallel
 * tool registry — "any feature the app does via its API is doable via MCP".
 */

/** A single JSON-Schema object property bag, as produced by {@link routeSchema}'s `z.toJSONSchema`. */
type JsonSchemaObject = {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

/** The shape of a manifest entry, re-exported from the contract for a single source of truth. */
export type ToolManifestEntry = agentTools.ToolManifestEntry;

/**
 * Derive a stable, snake_cased tool name from a route's method + path when the
 * route didn't pin one via `mcp.name`. The path is stripped of its `/api/` prefix,
 * `:param` placeholders are dropped (their VALUES live in the tool input, not the
 * name), and the HTTP method maps to an intent suffix so siblings on the same path
 * don't collide:
 *   - GET    → no suffix (the read of a collection/resource)
 *   - POST   → `_create`
 *   - PUT    → `_update`
 *   - PATCH  → `_update`
 *   - DELETE → `_delete`
 *
 * Examples: `GET /api/wiki` → `wiki`; `GET /api/wiki/:slug` → `wiki_get`;
 * `POST /api/vault/note` → `vault_note_create`; `DELETE /api/vault/note` →
 * `vault_note_delete`.
 */
export function deriveToolName(method: string, path: string): string {
  const verb = method.toUpperCase();
  const segments = path
    .replace(/^\/+/, "")
    .split("/")
    .filter((s) => s.length > 0)
    // Drop the leading `api` namespace and any `:param` placeholders.
    .filter((s, i) => !(i === 0 && s === "api") && !s.startsWith(":"))
    .map((s) => s.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase())
    .filter((s) => s.length > 0);

  const hasPathParam = path.includes("/:");
  const base = segments.join("_") || "root";

  // A single-resource GET (has a path param) reads better as `_get` than a bare
  // collection name, so `GET /api/wiki/:slug` is `wiki_get`, not `wiki`.
  if (verb === "GET") return hasPathParam ? `${base}_get` : base;
  if (verb === "POST") return `${base}_create`;
  if (verb === "PUT" || verb === "PATCH") return `${base}_update`;
  if (verb === "DELETE") return `${base}_delete`;
  return base;
}

/** Pull the `properties` map out of a converted JSON-Schema object, if any. */
function propsOf(schema: unknown): Record<string, unknown> {
  const obj = schema as JsonSchemaObject | undefined;
  if (obj && typeof obj === "object" && obj.properties && typeof obj.properties === "object") {
    return obj.properties;
  }
  return {};
}

/** Pull the `required` list out of a converted JSON-Schema object, if any. */
function requiredOf(schema: unknown): string[] {
  const obj = schema as JsonSchemaObject | undefined;
  return Array.isArray(obj?.required) ? obj.required : [];
}

/** The names a path template declares as `:params`, e.g. `/api/wiki/:slug` → `["slug"]`. */
function pathParamNames(path: string): string[] {
  return Array.from(path.matchAll(/:([a-zA-Z0-9_]+)/g), (m) => m[1] as string);
}

/**
 * Merge a route's path params + querystring + body into ONE JSON-Schema object the
 * MCP server hands to the agent as the tool's input schema. The agent supplies a
 * single flat argument bag; the generator later re-splits it (path params into the
 * URL, the rest into query/body) when it rebuilds the request.
 *
 * Precedence on key clash is path → body → query (most-specific binding wins), and
 * every path param is forced to a required string regardless of any other source.
 * `params`/`querystring`/`body` are the already-converted draft-7 schemas Fastify
 * holds on `routeOptions.schema`.
 */
export function buildInputSchema(
  path: string,
  schema: { params?: unknown; querystring?: unknown; body?: unknown },
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();

  // Query first so body/path overwrite a same-named query prop.
  Object.assign(properties, propsOf(schema.querystring));
  for (const key of requiredOf(schema.querystring)) required.add(key);

  Object.assign(properties, propsOf(schema.body));
  for (const key of requiredOf(schema.body)) required.add(key);

  // Path params last and authoritative: always present, always a required string.
  for (const name of pathParamNames(path)) {
    properties[name] = { type: "string", description: `Path parameter \`${name}\`.` };
    required.add(name);
  }

  const input: Record<string, unknown> = { type: "object", properties };
  if (required.size > 0) input.required = Array.from(required);
  return input;
}

/** Read the resolved `x-mcp` annotation off a route's schema, if present. */
function mcpAnnotation(routeOptions: RouteOptions): RouteMcpAnnotation | undefined {
  const schema = routeOptions.schema as { [MCP_EXTENSION_KEY]?: RouteMcpAnnotation } | undefined;
  return schema?.[MCP_EXTENSION_KEY];
}

/**
 * Collects the generated MCP tool manifest as routes register. Construct one,
 * attach its hook with {@link registerMcpManifestHook} BEFORE the route plugins
 * run, then read {@link list} once the server is ready (or any time after).
 */
export class McpManifest {
  /** Keyed by tool name so the LAST writer wins and lookups stay O(1). */
  private readonly entries = new Map<string, ToolManifestEntry>();

  /**
   * Record a single route if it opted into MCP and is safe to auto-expose. A route
   * is skipped when it has no `x-mcp` annotation, `expose` is not `true`, or its
   * `safety` is `"destructive"` — the generated surface never auto-exposes an
   * irreversible operation.
   */
  consider(routeOptions: RouteOptions): void {
    const mcp = mcpAnnotation(routeOptions);
    if (!mcp || mcp.expose !== true) return;

    const safety: McpSafety = mcp.safety ?? "write";
    if (safety === "destructive") return;

    // Fastify fires onRoute once per verb, and auto-adds a HEAD alongside every GET.
    // A HEAD carries no body and is just the GET's metadata probe, so it's never a
    // tool of its own — skip it (the sibling GET is recorded separately). When a
    // route declares multiple real verbs we record the first non-HEAD one.
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    const primary = methods.find((m) => m.toUpperCase() !== "HEAD");
    if (!primary) return; // a HEAD-only (or method-less) route is not a tool.
    const method = primary.toUpperCase();

    const path = routeOptions.url;
    const schema = (routeOptions.schema ?? {}) as {
      summary?: string;
      params?: unknown;
      querystring?: unknown;
      body?: unknown;
    };

    const entry: ToolManifestEntry = {
      name: mcp.name ?? deriveToolName(method, path),
      method,
      path,
      summary: typeof schema.summary === "string" ? schema.summary : "",
      // `safety` is narrowed to "read" | "write" here — the destructive case
      // returned early above, so it can never reach the manifest.
      safety,
      inputSchema: buildInputSchema(path, schema),
    };
    this.entries.set(entry.name, entry);
  }

  /** The collected entries, in stable name order for a deterministic manifest. */
  list(): ToolManifestEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => a.name.localeCompare(b.name));
  }
}

/**
 * Wire a {@link McpManifest} to an app's route registration. Register this BEFORE
 * the route plugins so the `onRoute` hook sees every route as it is added; the
 * manifest is then complete by the time the server is ready.
 */
export function registerMcpManifestHook(app: FastifyInstance, manifest: McpManifest): void {
  app.addHook("onRoute", (routeOptions) => {
    manifest.consider(routeOptions);
  });
}
