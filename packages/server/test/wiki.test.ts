import { ErrorCode, ErrorEnvelopeSchema, wiki } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/wiki", () => {
  it("returns the entity list matching the contract (empty on a fresh DB)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/wiki" });
    expect(res.statusCode).toBe(200);
    const parsed = wiki.ListEntitiesResponse.parse(res.json());
    expect(parsed.entities).toEqual([]);
  });
});

describe("GET /api/wiki/graph", () => {
  it("returns nodes + links matching the contract", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/wiki/graph" });
    expect(res.statusCode).toBe(200);
    const parsed = wiki.WikiGraphResponse.parse(res.json());
    expect(parsed.nodes).toEqual([]);
    expect(parsed.links).toEqual([]);
  });

  it("decorates edges with confidence and source provenance (#89)", async () => {
    const { store } = server.ctx;
    // Two documented people linked by a relationship backed by a real source, so
    // both endpoints warrant a wiki page and the edge survives the route's filter.
    const a = store.createEntity({ type: "person", name: "Graph A" });
    const b = store.createEntity({ type: "person", name: "Graph B" });
    const src = store.createSource({ type: "file", title: "Graph notes", content: "..." });
    store.insertObservation({ entityId: a.id, text: "Graph A leads.", sourceId: src });
    store.insertObservation({ entityId: b.id, text: "Graph B helps.", sourceId: src });
    store.upsertRelationship(a.id, b.id, "works with", src);

    const res = await server.app.inject({ method: "GET", url: "/api/wiki/graph" });
    const parsed = wiki.WikiGraphResponse.parse(res.json());
    const edge = parsed.links.find((l) => l.from === a.id && l.to === b.id);
    expect(edge).toBeDefined();
    expect(typeof edge!.confidence).toBe("number");
    expect(edge!.sourceId).toBe(src);
    expect(edge!.sourceCount).toBe(1);
    // A single-source edge below the reinforcement cap is a "generated" proxy.
    expect(edge!.confirmed).toBe(false);
    // Nodes now carry the entity summary for the focus/inspect panel.
    const node = parsed.nodes.find((n) => n.id === a.id);
    expect(node).toBeDefined();
    expect(node).toHaveProperty("summary");
  });
});

describe("GET /api/wiki/:slug", () => {
  it("404s with the NOT_FOUND envelope for an unknown slug", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/wiki/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
    expect(typeof envelope.requestId).toBe("string");
  });

  it("returns a full page for a seeded entity, matching the contract", async () => {
    // Seed an entity directly through the store so the slug resolves.
    const entity = server.ctx.store.createEntity({ type: "project", name: "Orion Test" });
    const res = await server.app.inject({ method: "GET", url: `/api/wiki/${entity.slug}` });
    expect(res.statusCode).toBe(200);
    const parsed = wiki.WikiPageResponse.parse(res.json());
    expect(parsed.entity.slug).toBe(entity.slug);
    expect(parsed.entity.name).toBe("Orion Test");
  });
});

describe("GET /api/entities/duplicates", () => {
  it("surfaces an org-suffix variant as a confidence-scored proposal", async () => {
    // Seed an organisation written two ways; entity resolution should pair them.
    server.ctx.store.createEntity({ type: "organisation", name: "Globex" });
    server.ctx.store.createEntity({ type: "organisation", name: "Globex Inc." });
    const res = await server.app.inject({ method: "GET", url: "/api/entities/duplicates" });
    expect(res.statusCode).toBe(200);
    const parsed = wiki.DuplicatesResponse.parse(res.json());
    const pair = parsed.duplicates.find(
      (d) => [d.aName, d.bName].includes("Globex") && [d.aName, d.bName].includes("Globex Inc."),
    );
    expect(pair).toBeDefined();
    expect(pair!.score).toBeGreaterThan(0.5);
  });
});

describe("POST /api/entities/merge", () => {
  it("rejects a non-numeric merge body with the VALIDATION_ERROR envelope", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/entities/merge",
      payload: { loserId: "x", winnerId: "y" },
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

// Defined last: it seeds entities into the shared server, so it must run after the
// "empty on a fresh DB" assertions above.
describe("GET /api/wiki — connector references stay out of the index", () => {
  it("lists entities with page-worthy backing but hides connector-only people", async () => {
    const { store } = server.ctx;
    // A person mentioned by a real document → warrants a page, must be listed.
    const documented = store.createEntity({ type: "person", name: "Listed Person" });
    const fileSrc = store.createSource({ type: "file", title: "Notes", content: "..." });
    store.insertObservation({
      entityId: documented.id,
      text: "Listed Person leads the project.",
      sourceId: fileSrc,
    });
    // A person known only from a contact → reference only, must be hidden.
    const contactOnly = store.createEntity({ type: "person", name: "Contact Only Person" });
    const contactSrc = store.createSource({
      type: "google:contacts",
      title: "Contact",
      content: "...",
    });
    store.insertObservation({
      entityId: contactOnly.id,
      text: "Contact Only Person — email c@example.com.",
      sourceId: contactSrc,
    });

    const res = await server.app.inject({ method: "GET", url: "/api/wiki" });
    const parsed = wiki.ListEntitiesResponse.parse(res.json());
    const names = parsed.entities.map((e) => e.name);
    expect(names).toContain("Listed Person");
    expect(names).not.toContain("Contact Only Person");
  });
});
