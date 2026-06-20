import { z } from "zod";

/**
 * @meos/contracts — the agent-tools surface: the GENERATED MCP projection of the
 * annotated HTTP API.
 *
 * `GET /api/agent/tool-manifest` returns one {@link ToolManifestEntry} per route
 * that opted into MCP exposure (via `routeSchema({ mcp: { expose: true, safety } })`
 * in `@meos/server`). The wiki-mcp generator fetches this manifest and registers a
 * matching MCP tool for each entry — so "any feature the app does via its API is
 * doable via MCP" without a hand-written tool per endpoint.
 */

/**
 * How dangerous a tool is to call, mirrored from the server's `McpSafety`. The
 * manifest never emits `"destructive"` — those routes are filtered out before the
 * response — but the union keeps the field honest if a future surface opts them in.
 */
export const ToolSafetySchema = z.enum(["read", "write", "destructive"]);

/**
 * One agent-callable tool: enough for the MCP generator to (a) advertise it and
 * (b) reconstruct the underlying HTTP request without re-deriving anything.
 */
export const ToolManifestEntrySchema = z.object({
  /** Stable tool name (the route's `mcp.name`, or derived from method+path). */
  name: z.string(),
  /** HTTP method the tool maps to, uppercased (GET/POST/PUT/PATCH/DELETE). */
  method: z.string(),
  /** The route's path template, with `:param` placeholders, e.g. `/api/wiki/:slug`. */
  path: z.string(),
  /** The route's one-line summary, surfaced as the MCP tool description. */
  summary: z.string(),
  /** Danger class; always `"read"` or `"write"` here (destructive is excluded). */
  safety: ToolSafetySchema,
  /**
   * A SINGLE JSON-Schema object the MCP server uses verbatim as the tool's input
   * schema. Path params, querystring props, and body props are merged into one
   * flat object: `{ type: "object", properties, required }`. Path params are
   * always required strings; body/query props keep their converted shapes. Left
   * as an opaque record because it is an arbitrary draft-7 JSON-Schema blob that a
   * strict Zod response schema would silently strip.
   */
  inputSchema: z.record(z.string(), z.unknown()),
});

/** `GET /api/agent/tool-manifest` — the full generated MCP tool projection. */
export const ToolManifestResponse = z.object({
  tools: z.array(ToolManifestEntrySchema),
});

export type ToolSafety = z.infer<typeof ToolSafetySchema>;
export type ToolManifestEntry = z.infer<typeof ToolManifestEntrySchema>;
export type ToolManifestResponseT = z.infer<typeof ToolManifestResponse>;
