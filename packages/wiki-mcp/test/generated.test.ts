import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGeneratedTools } from "../src/generated.js";

/**
 * The generated-tools projection (client.ts + generated.ts) under PROGRESSIVE
 * DISCLOSURE: rather than registering one MCP tool per manifest entry (which floods
 * the agent's context with ~70 tools), it fetches the manifest once and exposes it
 * behind three meta-tools — `search_tools`, `learn_tools`, `run_tool`. These tests
 * mock `fetch` so no server is needed, and assert that ONLY the meta-tools are
 * registered, that search filters by query, that learn returns a tool's schema, that
 * run rebuilds the right HTTP request, and that unknown names error / a dead manifest
 * degrades gracefully.
 */

const BASE = "http://meos.test:4321";

type ToolResult = { content: { text: string }[]; isError?: boolean };

/** A small manifest: a path-param GET and a body POST. */
const MANIFEST = {
  tools: [
    {
      name: "wiki_get",
      method: "GET",
      path: "/api/wiki/:slug",
      summary: "Get a wiki page",
      safety: "read",
      inputSchema: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      },
    },
    {
      name: "vault_note_create",
      method: "POST",
      path: "/api/vault/note",
      summary: "Create a note",
      safety: "write",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "calendar_events",
      method: "GET",
      path: "/api/calendar/events",
      summary: "List calendar events",
      safety: "read",
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

/** Capture what registerTool was handed, and let us invoke a meta-tool's handler directly. */
function spyServer(): {
  server: McpServer;
  calls: { name: string; handler: (args: Record<string, unknown>) => unknown }[];
} {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const calls: { name: string; handler: (args: Record<string, unknown>) => unknown }[] = [];
  vi.spyOn(server, "registerTool").mockImplementation((name, _config, handler) => {
    calls.push({ name, handler: handler as (a: Record<string, unknown>) => unknown });
    return {} as ReturnType<McpServer["registerTool"]>;
  });
  return { server, calls };
}

/** Stub global fetch to return our manifest on the manifest URL, and echo other calls. */
function mockFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
    if (input.endsWith("/api/agent/tool-manifest")) {
      return new Response(JSON.stringify(MANIFEST), { status: 200 });
    }
    // Echo the request shape back so run_tool tests can read what was sent.
    return new Response(JSON.stringify({ url: input, method: init?.method, body: init?.body }), {
      status: 200,
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Grab a registered meta-tool's handler by name. */
function handlerFor(
  calls: { name: string; handler: (args: Record<string, unknown>) => unknown }[],
  name: string,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  const call = calls.find((c) => c.name === name);
  if (!call) throw new Error(`meta-tool "${name}" was not registered`);
  return call.handler as (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** Parse the JSON payload a meta-tool returns as MCP text content. */
function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("registerGeneratedTools (progressive disclosure)", () => {
  it("registers ONLY the three meta-tools, not one per manifest entry", async () => {
    mockFetch();
    const { server, calls } = spyServer();

    const registered = await registerGeneratedTools(server, BASE);

    // The bloat fix: the agent sees three meta-tools, never the 70-odd generated ones.
    expect(registered.sort()).toEqual(["learn_tools", "run_tool", "search_tools"]);
    expect(calls.map((c) => c.name).sort()).toEqual(["learn_tools", "run_tool", "search_tools"]);
    // No per-entry tool leaked through.
    expect(calls.map((c) => c.name)).not.toContain("wiki_get");
    expect(calls.map((c) => c.name)).not.toContain("vault_note_create");
  });

  it("skips a meta-tool whose name a curated tool already reserved", async () => {
    mockFetch();
    const { server, calls } = spyServer();

    const registered = await registerGeneratedTools(server, BASE, ["search_tools"]);

    expect(registered.sort()).toEqual(["learn_tools", "run_tool"]);
    expect(calls.map((c) => c.name)).not.toContain("search_tools");
  });

  describe("search_tools", () => {
    it("filters the manifest by query (case-insensitive)", async () => {
      mockFetch();
      const { server, calls } = spyServer();
      await registerGeneratedTools(server, BASE);

      const search = handlerFor(calls, "search_tools");
      const result = await search({ query: "WIKI" });
      const body = payload(result);

      expect(body.matched).toBe(1);
      const tools = body.tools as { name: string; summary: string; safety: string }[];
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ name: "wiki_get", safety: "read" });
      // The non-matching entries are absent.
      expect(tools.map((t) => t.name)).not.toContain("vault_note_create");
    });

    it("returns an overview of all tools when the query is empty", async () => {
      mockFetch();
      const { server, calls } = spyServer();
      await registerGeneratedTools(server, BASE);

      const search = handlerFor(calls, "search_tools");
      const body = payload(await search({}));

      expect(body.total).toBe(MANIFEST.tools.length);
      expect((body.tools as unknown[]).length).toBe(MANIFEST.tools.length);
    });
  });

  describe("learn_tools", () => {
    it("returns the full input schema + method/path for a named tool", async () => {
      mockFetch();
      const { server, calls } = spyServer();
      await registerGeneratedTools(server, BASE);

      const learn = handlerFor(calls, "learn_tools");
      const body = payload(await learn({ names: ["wiki_get"] }));

      const tools = body.tools as {
        name: string;
        method: string;
        path: string;
        inputSchema: unknown;
      }[];
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        name: "wiki_get",
        method: "GET",
        path: "/api/wiki/:slug",
      });
      expect(tools[0]!.inputSchema).toEqual(MANIFEST.tools[0]!.inputSchema);
      expect(body.unknown).toEqual([]);
    });

    it("reports unknown names back instead of throwing", async () => {
      mockFetch();
      const { server, calls } = spyServer();
      await registerGeneratedTools(server, BASE);

      const learn = handlerFor(calls, "learn_tools");
      const body = payload(await learn({ names: ["nope"] }));

      expect(body.tools).toEqual([]);
      expect(body.unknown).toEqual(["nope"]);
    });
  });

  describe("run_tool", () => {
    it("substitutes a path param into the URL for a GET tool (no body)", async () => {
      const fetchFn = mockFetch();
      const { server, calls } = spyServer();
      await registerGeneratedTools(server, BASE);

      const run = handlerFor(calls, "run_tool");
      const result = await run({ name: "wiki_get", args: { slug: "ada lovelace" } });

      const lastCall = fetchFn.mock.calls.at(-1)!;
      expect(lastCall[0]).toBe(`${BASE}/api/wiki/ada%20lovelace`);
      expect(lastCall[1]).toMatchObject({ method: "GET" });
      expect(lastCall[1]?.body).toBeUndefined();
      expect(result.content[0]?.text).toContain("/api/wiki/ada%20lovelace");
    });

    it("sends non-path args as a JSON body for a POST tool", async () => {
      const fetchFn = mockFetch();
      const { server, calls } = spyServer();
      await registerGeneratedTools(server, BASE);

      const run = handlerFor(calls, "run_tool");
      await run({ name: "vault_note_create", args: { path: "ideas/new.md" } });

      const lastCall = fetchFn.mock.calls.at(-1)!;
      expect(lastCall[0]).toBe(`${BASE}/api/vault/note`);
      expect(lastCall[1]).toMatchObject({ method: "POST" });
      expect(JSON.parse(lastCall[1]!.body as string)).toEqual({ path: "ideas/new.md" });
    });

    it("errors clearly on an unknown tool name", async () => {
      mockFetch();
      const { server, calls } = spyServer();
      await registerGeneratedTools(server, BASE);

      const run = handlerFor(calls, "run_tool");
      const result = await run({ name: "does_not_exist", args: {} });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Unknown tool "does_not_exist"');
    });
  });

  describe("graceful degradation", () => {
    it("still registers the meta-tools when the manifest fetch fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      );
      const { server, calls } = spyServer();

      const registered = await registerGeneratedTools(server, BASE);

      // Meta-tools are registered even offline, so the server setup never throws.
      expect(registered.sort()).toEqual(["learn_tools", "run_tool", "search_tools"]);
      expect(calls).toHaveLength(3);
    });

    it("reports the manifest is unavailable when called offline", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      );
      const { server, calls } = spyServer();
      await registerGeneratedTools(server, BASE);

      const search = handlerFor(calls, "search_tools");
      const result = await search({ query: "wiki" });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text.toLowerCase()).toContain("unavailable");
    });
  });
});
