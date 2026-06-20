import { agentTools } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

/**
 * The GENERATED MCP surface: `GET /api/agent/tool-manifest` projects every route
 * that opted into MCP (via `routeSchema({ mcp: { expose, safety } })`) into one
 * tool descriptor the wiki-mcp generator turns into a live MCP tool. These tests
 * pin the projection: the annotated read routes appear with the right name /
 * method / path / merged inputSchema, and everything un-annotated (or destructive)
 * is excluded — so the surface is opt-in and an agent can't reach an irreversible
 * operation through it.
 */
describe("GET /api/agent/tool-manifest", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await buildTestServer();
  });
  afterAll(async () => {
    await server.cleanup();
  });

  it("validates against the contract and exposes only the annotated read routes", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/agent/tool-manifest" });
    expect(res.statusCode).toBe(200);

    // The response must satisfy the shared contract (an empty/garbled body fails here).
    const { tools } = agentTools.ToolManifestResponse.parse(res.json());

    const byName = new Map(tools.map((t) => [t.name, t]));

    // The three routes annotated to demonstrate the pipeline.
    const wikiList = byName.get("wiki");
    expect(wikiList).toMatchObject({ method: "GET", path: "/api/wiki", safety: "read" });
    expect(wikiList?.summary).toBe("List wiki entities");

    const vaultList = byName.get("vault");
    expect(vaultList).toMatchObject({ method: "GET", path: "/api/vault", safety: "read" });

    const wikiPage = byName.get("wiki_get");
    expect(wikiPage).toMatchObject({ method: "GET", path: "/api/wiki/:slug", safety: "read" });
  });

  it("merges the path param into a single object inputSchema (required string)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/agent/tool-manifest" });
    const { tools } = agentTools.ToolManifestResponse.parse(res.json());
    const wikiPage = tools.find((t) => t.name === "wiki_get")!;

    // `/api/wiki/:slug` ⇒ a single object schema with `slug` as a required string.
    expect(wikiPage.inputSchema).toMatchObject({ type: "object" });
    const props = (wikiPage.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.slug).toMatchObject({ type: "string" });
    const required = (wikiPage.inputSchema as { required?: string[] }).required ?? [];
    expect(required).toContain("slug");
  });

  it("a no-input read route gets an empty-object inputSchema", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/agent/tool-manifest" });
    const { tools } = agentTools.ToolManifestResponse.parse(res.json());
    const wikiList = tools.find((t) => t.name === "wiki")!;
    expect(wikiList.inputSchema).toMatchObject({ type: "object", properties: {} });
  });

  it("excludes un-annotated routes and never exposes destructive ones", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/agent/tool-manifest" });
    const { tools } = agentTools.ToolManifestResponse.parse(res.json());
    const names = new Set(tools.map((t) => t.name));
    const paths = new Set(tools.map((t) => t.path));

    // `/api/wiki/graph` is a read but NOT annotated → absent (opt-in only).
    expect(paths.has("/api/wiki/graph")).toBe(false);

    // The vault write/destructive routes are never projected: no entry targets
    // `DELETE /api/vault/note`, and no exposed tool is marked destructive.
    const deletes = tools.filter((t) => t.method === "DELETE");
    expect(deletes).toEqual([]);
    for (const t of tools) expect(t.safety).not.toBe("destructive");

    // None of the connector-tool helper endpoints leak into the manifest.
    expect(names.has("agent_connector_tools")).toBe(false);
  });
});
