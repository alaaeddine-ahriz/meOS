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
