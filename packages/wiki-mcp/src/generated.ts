/**
 * The GENERATED half of the meOS MCP surface.
 *
 * Where the curated wiki tools (index.ts) are hand-written for the maintenance
 * workflow, these tools are a PROJECTION of the app's annotated HTTP API: meOS
 * serves a manifest of every route that opted into MCP (via `routeSchema({ mcp })`),
 * and this module turns each manifest entry into a live MCP tool. The upshot is
 * "any feature the app exposes via its annotated API is callable over MCP" without a
 * bespoke tool per endpoint — new exposed routes appear as tools automatically.
 *
 * A generated tool's handler reconstructs the original request from the manifest:
 * path params are substituted into the URL template, and the remaining arguments go
 * into the querystring (GET) or the JSON body (everything else). The JSON response
 * comes back as MCP text content.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  callGenerated,
  getToolManifest,
  type HttpMethod,
  type ToolManifestEntry,
} from "./client.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** A flat JSON-Schema object: what the manifest's `inputSchema` always is. */
interface JsonSchemaObject {
  type?: unknown;
  properties?: Record<string, { type?: unknown; description?: unknown } | undefined>;
  required?: unknown;
}

/**
 * Convert one manifest property's JSON Schema into a permissive Zod type so the
 * high-level {@link McpServer} (which wants Zod shapes, not raw JSON Schema) can
 * register the tool. We intentionally keep the mapping loose — the server
 * re-validates every request with its own contract — so the agent is never blocked
 * by a too-strict client-side schema; the goal here is a usable, described input.
 */
function zodForProp(prop: { type?: unknown; description?: unknown } | undefined): z.ZodTypeAny {
  const describe = (schema: z.ZodTypeAny): z.ZodTypeAny =>
    typeof prop?.description === "string" ? schema.describe(prop.description) : schema;

  switch (prop?.type) {
    case "string":
      return describe(z.string());
    case "number":
    case "integer":
      return describe(z.number());
    case "boolean":
      return describe(z.boolean());
    case "array":
      return describe(z.array(z.unknown()));
    // `object`, unions, or an unspecified type: accept anything and let the server
    // validate. `z.unknown()` keeps the property optional-friendly and lossless.
    default:
      return describe(z.unknown());
  }
}

/** Turn a manifest entry's merged JSON-Schema object into a Zod raw shape for registerTool. */
function toZodShape(inputSchema: Record<string, unknown>): z.ZodRawShape {
  const schema = inputSchema as JsonSchemaObject;
  const props = schema.properties ?? {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);

  // Build into a mutable record — zod v4 types `ZodRawShape` as readonly — then
  // hand it to registerTool as the shape.
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    const base = zodForProp(prop);
    shape[key] = required.has(key) ? base : base.optional();
  }
  return shape as z.ZodRawShape;
}

/** The path-param names a template declares, e.g. `/api/wiki/:slug` → `["slug"]`. */
function pathParamNames(path: string): string[] {
  return Array.from(path.matchAll(/:([a-zA-Z0-9_]+)/g), (m) => m[1] as string);
}

/**
 * Build the concrete request from the tool's flat argument bag: substitute path
 * params into the URL template (URL-encoded), then route the REMAINING args into the
 * querystring for a GET or the JSON body for any other method — exactly inverting how
 * the server merged params/query/body into one input schema.
 */
function buildRequest(
  entry: ToolManifestEntry,
  args: Record<string, unknown>,
): { method: HttpMethod; path: string; body?: unknown } {
  const params = new Set(pathParamNames(entry.path));

  let path = entry.path;
  for (const name of params) {
    const value = args[name];
    path = path.replace(`:${name}`, encodeURIComponent(value === undefined ? "" : String(value)));
  }

  // Everything that wasn't a path param is a query/body field.
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!params.has(key)) rest[key] = value;
  }

  const method = entry.method.toUpperCase() as HttpMethod;
  if (method === "GET" || method === "DELETE") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined && value !== null) query.append(key, String(value));
    }
    const qs = query.toString();
    return { method, path: qs.length > 0 ? `${path}?${qs}` : path };
  }
  return { method, path, body: rest };
}

/** Run a generated tool's request and shape the result into MCP text content. */
async function runGenerated(
  baseUrl: string,
  entry: ToolManifestEntry,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const { method, path, body } = buildRequest(entry, args);
    const result = await callGenerated(baseUrl, method, path, body);
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/**
 * Fetch the meOS tool manifest and register a matching MCP tool for each entry on
 * `server`, against `baseUrl`. Returns the names that were actually registered.
 *
 * Call this AFTER the curated wiki tools are registered: any manifest tool whose
 * name collides with an already-registered curated tool is SKIPPED (curated wins),
 * so the hand-tuned maintenance workflow is never shadowed by a generic projection.
 * An unreachable server or empty manifest registers nothing — the curated tools
 * still work, so the server stays useful offline.
 *
 * @param reserved - names already taken by curated tools; collisions are skipped.
 */
export async function registerGeneratedTools(
  server: McpServer,
  baseUrl: string,
  reserved: Iterable<string> = [],
): Promise<string[]> {
  let manifest: ToolManifestEntry[];
  try {
    manifest = await getToolManifest(baseUrl);
  } catch (err) {
    // stdout is the MCP transport — diagnostics go to stderr only. A missing server
    // just means no generated tools this run, not a crash.
    console.error(
      "[meos-wiki-mcp] could not load the tool manifest:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  const taken = new Set(reserved);
  const registered: string[] = [];

  for (const entry of manifest) {
    if (taken.has(entry.name)) continue; // curated (or an earlier generated) tool wins.
    taken.add(entry.name);

    server.registerTool(
      entry.name,
      {
        description: entry.summary || `${entry.method} ${entry.path}`,
        inputSchema: toZodShape(entry.inputSchema),
      },
      (args: Record<string, unknown>) => runGenerated(baseUrl, entry, args ?? {}),
    );
    registered.push(entry.name);
  }

  return registered;
}
