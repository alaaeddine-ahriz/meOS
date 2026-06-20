import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGeneratedTools } from "../src/generated.js";

/**
 * The generated-tools projection (client.ts + generated.ts): fetch the meOS tool
 * manifest and register a live MCP tool per entry, reconstructing each entry's HTTP
 * request from the agent's flat argument bag. These tests mock `fetch` so no server
 * is needed — they assert the manifest drives registration, that curated names are
 * never shadowed, and that invoking a handler issues the right method/URL/body.
 */

const BASE = "http://meos.test:4321";

/** A small two-tool manifest: a path-param GET and a body POST. */
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
      // Collides with a curated tool name — must be skipped (curated wins).
      name: "wiki_search",
      method: "GET",
      path: "/api/search",
      summary: "Search",
      safety: "read",
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

/** Capture what registerTool was handed, and let us invoke a tool's handler directly. */
function spyServer(): {
  server: McpServer;
  calls: { name: string; handler: (args: Record<string, unknown>) => unknown }[];
} {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const calls: { name: string; handler: (args: Record<string, unknown>) => unknown }[] = [];
  vi.spyOn(server, "registerTool").mockImplementation((name, _config, handler) => {
    calls.push({ name, handler: handler as (a: Record<string, unknown>) => unknown });
    // Return a minimal RegisteredTool stand-in; generated.ts ignores the return.
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
    // Echo the request shape back so handler tests can read what was sent.
    return new Response(JSON.stringify({ url: input, method: init?.method, body: init?.body }), {
      status: 200,
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("registerGeneratedTools", () => {
  it("registers a tool per manifest entry and skips curated-name collisions", async () => {
    mockFetch();
    const { server, calls } = spyServer();

    const registered = await registerGeneratedTools(server, BASE, ["wiki_search"]);

    // wiki_search collides with the reserved curated name → skipped (curated wins).
    expect(registered.sort()).toEqual(["vault_note_create", "wiki_get"]);
    expect(calls.map((c) => c.name).sort()).toEqual(["vault_note_create", "wiki_get"]);
  });

  it("substitutes a path param into the URL for a GET handler", async () => {
    const fetchFn = mockFetch();
    const { server, calls } = spyServer();
    await registerGeneratedTools(server, BASE);

    const getTool = calls.find((c) => c.name === "wiki_get")!;
    const result = (await getTool.handler({ slug: "ada lovelace" })) as {
      content: { text: string }[];
    };

    // The path param was substituted + URL-encoded; no body on a GET.
    const lastCall = fetchFn.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe(`${BASE}/api/wiki/ada%20lovelace`);
    expect(lastCall[1]).toMatchObject({ method: "GET" });
    expect(lastCall[1]?.body).toBeUndefined();
    // The JSON response is surfaced as MCP text content.
    expect(result.content[0]?.text).toContain("/api/wiki/ada%20lovelace");
  });

  it("sends non-path args as a JSON body for a POST handler", async () => {
    const fetchFn = mockFetch();
    const { server, calls } = spyServer();
    await registerGeneratedTools(server, BASE);

    const postTool = calls.find((c) => c.name === "vault_note_create")!;
    await postTool.handler({ path: "ideas/new.md" });

    const lastCall = fetchFn.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe(`${BASE}/api/vault/note`);
    expect(lastCall[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(lastCall[1]!.body as string)).toEqual({ path: "ideas/new.md" });
  });

  it("registers nothing when the manifest fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const { server, calls } = spyServer();
    const registered = await registerGeneratedTools(server, BASE);
    expect(registered).toEqual([]);
    expect(calls).toEqual([]);
  });
});
