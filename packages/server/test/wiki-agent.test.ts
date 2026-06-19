import { wikiAgent } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

/** A stale, page-worthy person backed by a real file source (so it warrants a page). */
function seedPageWorthyEntity(name: string) {
  const { store } = server.ctx;
  const entity = store.createEntity({ type: "person", name });
  const src = store.createSource({ type: "file", title: `${name} notes`, content: "..." });
  store.insertObservation({
    entityId: entity.id,
    text: `${name} leads the Orion project.`,
    sourceId: src,
  });
  store.recordStaleSource(entity.id, src);
  return { entity, src };
}

describe("GET /api/wiki/agent/queue", () => {
  it("lists a stale, page-worthy entity with its new-source count and mode", async () => {
    const { entity } = seedPageWorthyEntity("Queue Person");
    const res = await server.app.inject({ method: "GET", url: "/api/wiki/agent/queue" });
    expect(res.statusCode).toBe(200);
    const parsed = wikiAgent.AgentQueueResponse.parse(res.json());
    expect(parsed.mode).toBe("in-app");
    const item = parsed.pages.find((p) => p.slug === entity.slug);
    expect(item).toBeDefined();
    expect(item!.stale).toBe(true);
    expect(item!.exists).toBe(false);
    expect(item!.newSources).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/wiki/agent/context/:slug", () => {
  it("returns the facts + linkable names needed to ground a page", async () => {
    const { entity } = seedPageWorthyEntity("Context Person");
    const res = await server.app.inject({
      method: "GET",
      url: `/api/wiki/agent/context/${entity.slug}`,
    });
    expect(res.statusCode).toBe(200);
    const parsed = wikiAgent.AgentContextResponse.parse(res.json());
    expect(parsed.entity.slug).toBe(entity.slug);
    expect(parsed.facts.some((f) => f.text.includes("Orion"))).toBe(true);
    expect(parsed.page.exists).toBe(false);
  });

  it("404s for an unknown slug", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/wiki/agent/context/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/wiki/agent/check", () => {
  it("flags a broken [[link]] and marks the page not-ok", async () => {
    const { entity } = seedPageWorthyEntity("Check Person");
    await server.app.inject({
      method: "POST",
      url: "/api/wiki/agent/write",
      payload: { slug: entity.slug, body: "Check Person works with [[Nobody Real]]." },
    });
    const res = await server.app.inject({
      method: "POST",
      url: "/api/wiki/agent/check",
      payload: { slugs: [entity.slug] },
    });
    const parsed = wikiAgent.AgentCheckResponse.parse(res.json());
    const result = parsed.results.find((r) => r.slug === entity.slug)!;
    expect(result.issues.some((i) => i.code === "broken_link")).toBe(true);
    expect(result.ok).toBe(false);
  });
});

describe("POST /api/wiki/agent/write + commit", () => {
  it("reconciles the page, clears stale, marks it agent-authored, and is idempotent", async () => {
    const { entity } = seedPageWorthyEntity("Commit Person");

    // Whole-body write (the no-filesystem path).
    const written = await server.app.inject({
      method: "POST",
      url: "/api/wiki/agent/write",
      payload: {
        slug: entity.slug,
        body: "Commit Person leads the Orion project and reviews scheduling.",
      },
    });
    expect(written.statusCode).toBe(200);
    expect(wikiAgent.AgentWriteResponse.parse(written.json()).written).toBe(true);

    // First commit → created, stale cleared, persisted as agent-authored.
    const first = await server.app.inject({
      method: "POST",
      url: "/api/wiki/agent/commit",
      payload: { slugs: [entity.slug] },
    });
    const firstParsed = wikiAgent.AgentCommitResponse.parse(first.json());
    expect(firstParsed.committed.map((c) => c.slug)).toContain(entity.slug);
    expect(firstParsed.committed[0]!.kind).toBe("created");
    expect(server.ctx.store.getEntity(entity.id)!.wiki_stale).toBe(0);
    const meta = server.ctx.store.wikiPageMeta(entity.id)!;
    expect(meta.authored_by).toBe("agent");
    expect(meta.body_hash).toBeTruthy();

    // Second commit with no new edits → skipped "unchanged" (shared-status idempotency).
    const second = await server.app.inject({
      method: "POST",
      url: "/api/wiki/agent/commit",
      payload: { slugs: [entity.slug] },
    });
    const secondParsed = wikiAgent.AgentCommitResponse.parse(second.json());
    expect(secondParsed.committed).toEqual([]);
    expect(secondParsed.skipped.find((s) => s.slug === entity.slug)?.reason).toBe("unchanged");
  });
});

describe("GET/PUT /api/wiki/agent/mode", () => {
  it("switches maintenance mode and reads it back", async () => {
    const put = await server.app.inject({
      method: "PUT",
      url: "/api/wiki/agent/mode",
      payload: { mode: "external" },
    });
    expect(wikiAgent.AgentModeResponse.parse(put.json()).mode).toBe("external");

    const get = await server.app.inject({ method: "GET", url: "/api/wiki/agent/mode" });
    expect(wikiAgent.AgentModeResponse.parse(get.json()).mode).toBe("external");

    // Reset so mode-sensitive behavior elsewhere is unaffected.
    await server.app.inject({
      method: "PUT",
      url: "/api/wiki/agent/mode",
      payload: { mode: "in-app" },
    });
  });

  it("rejects an invalid mode with a validation error", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/wiki/agent/mode",
      payload: { mode: "bogus" },
    });
    expect(res.statusCode).toBe(400);
  });
});
