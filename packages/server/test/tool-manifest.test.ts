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

  it("validates against the contract and exposes the annotated read routes", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/agent/tool-manifest" });
    expect(res.statusCode).toBe(200);

    // The response must satisfy the shared contract (an empty/garbled body fails here).
    const { tools } = agentTools.ToolManifestResponse.parse(res.json());

    const byName = new Map(tools.map((t) => [t.name, t]));

    // Foundational read tools.
    const wikiList = byName.get("wiki");
    expect(wikiList).toMatchObject({ method: "GET", path: "/api/wiki", safety: "read" });
    expect(wikiList?.summary).toBe("List wiki entities");

    const vaultList = byName.get("vault");
    expect(vaultList).toMatchObject({ method: "GET", path: "/api/vault", safety: "read" });

    const wikiPage = byName.get("wiki_get");
    expect(wikiPage).toMatchObject({ method: "GET", path: "/api/wiki/:slug", safety: "read" });

    // A representative spread of reads across the newly-annotated route groups.
    expect(byName.get("wiki_graph")).toMatchObject({ path: "/api/wiki/graph", safety: "read" });
    expect(byName.get("profile")).toMatchObject({ path: "/api/profile", safety: "read" });
    expect(byName.get("contradictions")).toMatchObject({
      path: "/api/contradictions",
      safety: "read",
    });
    expect(byName.get("meetings")).toMatchObject({ path: "/api/meetings", safety: "read" });
    expect(byName.get("sources")).toMatchObject({ path: "/api/sources", safety: "read" });
    expect(byName.get("connectors")).toMatchObject({ path: "/api/connectors", safety: "read" });
  });

  it("exposes the agent's native write primitives (knowledge / vault / profile / meetings)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/agent/tool-manifest" });
    const { tools } = agentTools.ToolManifestResponse.parse(res.json());
    const byName = new Map(tools.map((t) => [t.name, t]));

    // PR2's knowledge extraction primitives — the highest-priority writes.
    expect(byName.get("knowledge_entity_upsert")).toMatchObject({
      method: "POST",
      path: "/api/knowledge/entities",
      safety: "write",
    });
    expect(byName.get("knowledge_observation_add")).toMatchObject({
      method: "POST",
      path: "/api/knowledge/observations",
      safety: "write",
    });
    expect(byName.get("knowledge_relationship_add")).toMatchObject({
      method: "POST",
      path: "/api/knowledge/relationships",
      safety: "write",
    });

    // A spread of other reversible writes that are auto-exposed.
    expect(byName.get("vault_note_create")).toMatchObject({ safety: "write", method: "POST" });
    expect(byName.get("vault_note_save")).toMatchObject({ safety: "write", method: "PUT" });
    expect(byName.get("profile_section_save")).toMatchObject({ safety: "write" });
    expect(byName.get("meetings_create")).toMatchObject({ safety: "write", method: "POST" });
    expect(byName.get("connectors_task_create")).toMatchObject({ safety: "write", method: "POST" });
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

    // `/api/intelligence-routing` is a config/control-plane route left un-annotated → absent.
    expect(paths.has("/api/intelligence-routing")).toBe(false);

    // No DELETE is ever projected (they are all annotated destructive or left off):
    // the agent-task / vault deletes never reach the manifest.
    const deletes = tools.filter((t) => t.method === "DELETE");
    expect(deletes).toEqual([]);
    expect(paths.has("/api/vault/note")).toBe(true); // the GET/PUT/POST forms ARE exposed…
    expect(tools.some((t) => t.method === "DELETE" && t.path === "/api/vault/note")).toBe(false);

    // Destructive routes are RECORDED with a safety tier but auto-EXCLUDED, so no
    // exposed tool is destructive and the specific irreversible ops never surface.
    for (const t of tools) expect(t.safety).not.toBe("destructive");
    expect(paths.has("/api/entities/merge")).toBe(false); // irreversible entity merge
    expect(paths.has("/api/ingest/dead-letter/clear")).toBe(false); // discards failed jobs
    // No connector disconnect/credentials/config mutation leaks in.
    expect(names.has("connectors_delete")).toBe(false);
    for (const t of tools) {
      expect(t.path).not.toBe("/api/connectors/:provider"); // disconnect (DELETE)
      expect(t.path).not.toBe("/api/connectors/:provider/credentials");
    }

    // None of the connector-tool helper endpoints leak into the manifest.
    expect(names.has("agent_connector_tools")).toBe(false);
  });
});
