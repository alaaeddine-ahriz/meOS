/**
 * The GENERATED half of the meOS MCP surface, exposed via PROGRESSIVE DISCLOSURE.
 *
 * Where the curated wiki tools (index.ts) are hand-written for the maintenance
 * workflow, these tools are a PROJECTION of the app's annotated HTTP API: meOS
 * serves a manifest of every route that opted into MCP (via `routeSchema({ mcp })`),
 * so "any feature the app exposes via its annotated API is callable over MCP".
 *
 * The catch is volume. The manifest holds ~70 entries, and registering one MCP tool
 * per entry floods the coding agent's context window — every tool's name + schema is
 * shipped on every turn, drowning the curated wiki tools and burning tokens before
 * the agent does any work. So instead of registering the long tail directly, we hide
 * it behind a SMALL fixed set of meta-tools the agent uses to discover and invoke
 * tools on demand:
 *
 *   - `search_tools(query)`  — find matching tools (compact name/summary/safety list)
 *   - `learn_tools(names)`   — get the full input schema + method/path for tool(s)
 *   - `run_tool(name, args)` — actually call one, rebuilding its original HTTP request
 *
 * This mirrors the in-app ToolRegistry pattern (the `search_tools` / `learn_tools` /
 * `run_tool` meta-tools that keep connector tools from bloating chat context), ported
 * here so the MCP server stays just as lean for external coding agents. The manifest
 * is fetched ONCE at startup and cached in a closure; the three meta-tools share it.
 *
 * `run_tool` reconstructs the original request from the manifest exactly as a direct
 * per-tool handler would: path params are substituted into the URL template, and the
 * remaining arguments go into the querystring (GET/DELETE) or the JSON body
 * (everything else). The JSON response comes back as MCP text content.
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

/** Cap on how many entries `search_tools` returns so a broad query can't refill context. */
const SEARCH_LIMIT = 25;

/** Wrap a string payload as MCP text content. */
function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** Wrap a JSON-serializable payload as pretty-printed MCP text content. */
function json(value: unknown): ToolResult {
  return text(JSON.stringify(value, null, 2));
}

/** Wrap an error message as a failed MCP tool result. */
function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** The path-param names a template declares, e.g. `/api/wiki/:slug` → `["slug"]`. */
function pathParamNames(path: string): string[] {
  return Array.from(path.matchAll(/:([a-zA-Z0-9_]+)/g), (m) => m[1] as string);
}

/**
 * Build the concrete request from the tool's flat argument bag: substitute path
 * params into the URL template (URL-encoded), then route the REMAINING args into the
 * querystring for a GET/DELETE or the JSON body for any other method — exactly
 * inverting how the server merged params/query/body into one input schema.
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

/** Run one manifest entry's request and shape the result into MCP text content. */
async function runEntry(
  baseUrl: string,
  entry: ToolManifestEntry,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const { method, path, body } = buildRequest(entry, args);
    const result = await callGenerated(baseUrl, method, path, body);
    const out = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return text(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(message);
  }
}

/** A compact, low-token view of a manifest entry — what `search_tools` lists. */
function summarize(entry: ToolManifestEntry): { name: string; summary: string; safety: string } {
  return {
    name: entry.name,
    summary: entry.summary || `${entry.method} ${entry.path}`,
    safety: entry.safety,
  };
}

/**
 * Score a manifest entry against a free-text query. We split the query into words and
 * count how many appear (case-insensitively) in the tool's name, summary, or path —
 * a forgiving keyword/substring match so the agent finds tools without knowing the
 * exact name. Zero means no match.
 */
function matchScore(entry: ToolManifestEntry, terms: string[]): number {
  const haystack = `${entry.name} ${entry.summary} ${entry.path}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

/**
 * The three meta-tools' handlers, closing over the (cached) manifest. Split out from
 * registration so the manifest can be supplied once — whether it loaded or not.
 */
function metaToolHandlers(baseUrl: string, manifest: ToolManifestEntry[], loaded: boolean) {
  const byName = new Map(manifest.map((e) => [e.name, e]));

  const unavailable = (): ToolResult =>
    failure(
      "The meOS tool manifest is unavailable (the meOS app may not be running). " +
        "Only the curated wiki tools are usable this session.",
    );

  /** Find tools whose name/summary/path match `query`; empty query → overview. */
  const searchTools = ({ query }: { query?: string }): ToolResult => {
    if (!loaded) return unavailable();

    const terms = (query ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    // Empty query → a short overview: the leading slice of tools so the agent can orient.
    if (terms.length === 0) {
      const shown = manifest.slice(0, SEARCH_LIMIT);
      return json({
        total: manifest.length,
        shown: shown.length,
        note:
          manifest.length > shown.length
            ? `Showing the first ${shown.length} of ${manifest.length} tools. ` +
              "Pass a `query` to narrow, then `learn_tools` for a tool's schema."
            : "Pass a `query` to narrow, then `learn_tools` for a tool's schema.",
        tools: shown.map(summarize),
      });
    }

    const ranked = manifest
      .map((entry) => ({ entry, score: matchScore(entry, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

    const shown = ranked.slice(0, SEARCH_LIMIT);
    return json({
      query: query ?? "",
      matched: ranked.length,
      shown: shown.length,
      note:
        ranked.length > shown.length
          ? `Showing the top ${shown.length} of ${ranked.length} matches. ` +
            "Call `learn_tools` with a name for its full input schema, then `run_tool`."
          : "Call `learn_tools` with a name for its full input schema, then `run_tool`.",
      tools: shown.map(({ entry }) => summarize(entry)),
    });
  };

  /** Return the full input schema + method/path/summary for the named tool(s). */
  const learnTools = ({ names }: { names?: string[] }): ToolResult => {
    if (!loaded) return unavailable();
    const wanted = Array.isArray(names) ? names : [];
    if (wanted.length === 0) {
      return failure("Pass `names`: a list of tool names (from `search_tools`) to describe.");
    }

    const found: unknown[] = [];
    const unknown: string[] = [];
    for (const name of wanted) {
      const entry = byName.get(name);
      if (!entry) {
        unknown.push(name);
        continue;
      }
      found.push({
        name: entry.name,
        method: entry.method,
        path: entry.path,
        safety: entry.safety,
        summary: entry.summary || `${entry.method} ${entry.path}`,
        inputSchema: entry.inputSchema,
      });
    }

    return json({
      tools: found,
      unknown,
      note:
        "Call `run_tool` with a tool's `name` and an `args` object matching its " +
        "inputSchema. Path parameters go in `args` alongside query/body fields.",
    });
  };

  /** Look up the named tool and perform its original HTTP request. */
  const runTool = async ({
    name,
    args,
  }: {
    name?: string;
    args?: Record<string, unknown>;
  }): Promise<ToolResult> => {
    if (!loaded) return unavailable();
    if (typeof name !== "string" || name.length === 0) {
      return failure("Pass `name`: the tool to run (discover names with `search_tools`).");
    }
    const entry = byName.get(name);
    if (!entry) {
      return failure(
        `Unknown tool "${name}". Use \`search_tools\` to find a valid name, then ` +
          "`learn_tools` for its schema.",
      );
    }
    return runEntry(baseUrl, entry, args ?? {});
  };

  return { searchTools, learnTools, runTool };
}

/**
 * Fetch the meOS tool manifest ONCE and register the three progressive-disclosure
 * meta-tools (`search_tools`, `learn_tools`, `run_tool`) over it on `server`, against
 * `baseUrl`. Returns the meta-tool names that were registered.
 *
 * This is the bloat fix: instead of ~70 individual generated tools (which flood the
 * coding agent's context), the agent sees only these three and discovers + invokes the
 * long tail on demand — mirroring the in-app ToolRegistry meta-tool pattern.
 *
 * Call this AFTER the curated wiki tools are registered. The meta-tool names are fixed
 * and won't collide with curated names; `reserved` is accepted for API symmetry (and
 * so a future curated tool of the same name would be detected) and any collision is
 * skipped, with the curated tool kept.
 *
 * Degrades gracefully: if the manifest fetch fails the meta-tools are STILL registered
 * but report that the manifest is unavailable, so server setup never throws and the
 * curated wiki workflow keeps working offline.
 *
 * @param reserved - names already taken by curated tools; collisions are skipped.
 */
export async function registerGeneratedTools(
  server: McpServer,
  baseUrl: string,
  reserved: Iterable<string> = [],
): Promise<string[]> {
  let manifest: ToolManifestEntry[] = [];
  let loaded = false;
  try {
    manifest = await getToolManifest(baseUrl);
    loaded = true;
  } catch (err) {
    // stdout is the MCP transport — diagnostics go to stderr only. A missing server
    // just means the meta-tools report "unavailable", not a crash.
    console.error(
      "[meos-wiki-mcp] could not load the tool manifest:",
      err instanceof Error ? err.message : err,
    );
  }

  const { searchTools, learnTools, runTool } = metaToolHandlers(baseUrl, manifest, loaded);
  const taken = new Set(reserved);
  const registered: string[] = [];

  const countNote = loaded
    ? `Currently ${manifest.length} tools are available behind these meta-tools.`
    : "The meOS tool manifest is currently unavailable (the meOS app may not be running).";

  /** Register one meta-tool unless a curated tool already reserved its name. */
  const register = (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    handler: (args: never) => ToolResult | Promise<ToolResult>,
  ): void => {
    if (taken.has(name)) return; // a curated tool of the same name wins.
    taken.add(name);
    // The SDK's registerTool is overloaded; cast the handler to its callback type.
    server.registerTool(name, { description, inputSchema }, handler as never);
    registered.push(name);
  };

  register(
    "search_tools",
    "Discover meOS API tools by free text instead of seeing them all at once. " +
      "Returns a compact list of { name, summary, safety } for tools whose name, " +
      "summary, or path match your query (case-insensitive keywords). Omit `query` " +
      "for an overview of available tool names. " +
      `Then call learn_tools for a tool's schema and run_tool to invoke it. ${countNote}`,
    {
      query: z
        .string()
        .optional()
        .describe("Keywords to match against tool names/summaries; omit for an overview."),
    },
    searchTools,
  );

  register(
    "learn_tools",
    "Get the full input schema, method, path, safety, and summary for one or more " +
      "tools found via search_tools, so you know exactly how to call them. Pass the " +
      "tool names; unknown names are reported back. Then invoke with run_tool.",
    { names: z.array(z.string()).describe("Tool names (from search_tools) to describe in full.") },
    learnTools,
  );

  register(
    "run_tool",
    "Invoke a meOS API tool by name with an `args` object matching its inputSchema " +
      "(see learn_tools). meOS rebuilds the original HTTP request — path params from " +
      "`args` fill the URL, the rest become the querystring (GET/DELETE) or JSON body — " +
      "and returns the JSON result. Unknown names error.",
    {
      name: z.string().describe("The tool to run (a name from search_tools)."),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Arguments matching the tool's inputSchema (path params + query/body)."),
    },
    runTool,
  );

  return registered;
}
