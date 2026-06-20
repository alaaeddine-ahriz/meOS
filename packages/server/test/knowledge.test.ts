import { knowledge } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("POST /api/knowledge/entities", () => {
  it("creates an entity, then resolves (not duplicates) a repeated name idempotently", async () => {
    const first = await server.app.inject({
      method: "POST",
      url: "/api/knowledge/entities",
      payload: { type: "person", name: "Grace Hopper", summary: "Computer scientist." },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = knowledge.UpsertEntityResponse.parse(first.json());
    expect(firstBody.created).toBe(true);
    expect(firstBody.slug).toBe("grace-hopper");
    // Response shape is the explicit z.object — guards the z.record serialize bug.
    expect(Object.keys(first.json()).sort()).toEqual(["created", "id", "slug"]);

    // Same name again → resolves to the same id, updates the summary, not created.
    const second = await server.app.inject({
      method: "POST",
      url: "/api/knowledge/entities",
      payload: { type: "person", name: "grace hopper", summary: "Rear admiral." },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = knowledge.UpsertEntityResponse.parse(second.json());
    expect(secondBody.created).toBe(false);
    expect(secondBody.id).toBe(firstBody.id);

    // Exactly one entity exists for that name, with the updated summary.
    const resolved = server.ctx.store.findEntityByName("Grace Hopper")!;
    expect(resolved.id).toBe(firstBody.id);
    expect(resolved.summary).toBe("Rear admiral.");
  });

  it("folds supplied aliases in so a later write by alias resolves to the same entity", async () => {
    const created = await server.app.inject({
      method: "POST",
      url: "/api/knowledge/entities",
      payload: { type: "organisation", name: "Acme Corporation", aliases: ["Acme", "ACME Inc"] },
    });
    const body = knowledge.UpsertEntityResponse.parse(created.json());

    // The alias now resolves to the same entity (exact name/alias match).
    const byAlias = server.ctx.store.findEntityByName("Acme");
    expect(byAlias?.id).toBe(body.id);
  });
});

describe("POST /api/knowledge/observations", () => {
  it("adds a manual fact, flags the page stale, and serializes the explicit response shape", async () => {
    // Seed a page-worthy entity so markWikiStale actually flags it.
    const { store } = server.ctx;
    const entity = store.createEntity({ type: "person", name: "Obs Person" });
    const src = store.createSource({ type: "file", title: "Obs notes", content: "..." });
    store.insertObservation({
      entityId: entity.id,
      text: "Obs Person leads Orion.",
      sourceId: src,
    });
    store.insertObservation({
      entityId: entity.id,
      text: "Obs Person mentors design.",
      sourceId: src,
    });
    store.insertObservation({
      entityId: entity.id,
      text: "Obs Person joined in 2019.",
      sourceId: src,
    });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/knowledge/observations",
      payload: {
        entity: { id: entity.id },
        text: "Obs Person prefers async standups.",
        kind: "preference",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = knowledge.AddObservationResponse.parse(res.json());
    expect(body.entityId).toBe(entity.id);
    expect(body.created).toBe(true);
    expect(body.staleFlagged).toBe(true);
    // Explicit z.object shape (guards the z.record serialize bug).
    expect(Object.keys(res.json()).sort()).toEqual([
      "created",
      "entityId",
      "observationId",
      "staleFlagged",
    ]);
    // The claim was actually persisted (no fabricated source quote required).
    expect(store.activeObservations(entity.id).some((o) => o.text.includes("async standups"))).toBe(
      true,
    );
  });

  it("resolves the entity by type+name, creating it when absent, and supports predicate+object", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/knowledge/observations",
      payload: {
        entity: { type: "person", name: "Resolved By Name" },
        predicate: "works at",
        object: "Globex",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = knowledge.AddObservationResponse.parse(res.json());
    const entity = server.ctx.store.getEntity(body.entityId)!;
    expect(entity.name).toBe("Resolved By Name");
    expect(
      server.ctx.store.activeObservations(entity.id).some((o) => o.text === "works at Globex"),
    ).toBe(true);
  });

  it("ties a fact to an existing source (source provenance) and locates the quote span", async () => {
    const { store } = server.ctx;
    const text = "Ada Lovelace leads the Orion project.";
    const sourceId = store.createSource({ type: "file", title: "Prov notes", content: text });
    store.createSourceRevision({ sourceId, normalizedContent: text, status: "active" });

    const res = await server.app.inject({
      method: "POST",
      url: "/api/knowledge/observations",
      payload: {
        entity: { type: "person", name: "Ada Knowledge" },
        text: "Ada Lovelace leads the Orion project",
        provenance: { kind: "source", sourceId, quote: "Ada Lovelace leads the Orion project." },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = knowledge.AddObservationResponse.parse(res.json());
    const quote = "Ada Lovelace leads the Orion project.";
    const obs = store.activeObservations(body.entityId).find((o) => o.source_id === sourceId)!;
    expect(obs).toBeDefined();
    expect(obs.char_start).toBe(text.indexOf(quote));
    expect(obs.char_end).toBe(text.indexOf(quote) + quote.length);
  });

  it("rejects a write with neither text nor predicate+object (400)", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/knowledge/observations",
      payload: { entity: { type: "person", name: "No Claim" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an entity ref with a name but no type (400 validation)", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/knowledge/observations",
      payload: { entity: { name: "Untyped" }, text: "Some claim." },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/knowledge/relationships", () => {
  it("creates an edge between two resolved entities, then reinforces it idempotently", async () => {
    const subject = { type: "person" as const, name: "Rel Subject" };
    const object = { type: "organisation" as const, name: "Rel Org" };

    const first = await server.app.inject({
      method: "POST",
      url: "/api/knowledge/relationships",
      payload: { subject, predicate: "Works At", object },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = knowledge.AddRelationshipResponse.parse(first.json());
    expect(firstBody.created).toBe(true);
    // Label normalised (trim + lowercase + collapse whitespace).
    expect(firstBody.predicate).toBe("works at");
    // Explicit z.object shape (guards the z.record serialize bug).
    expect(Object.keys(first.json()).sort()).toEqual([
      "created",
      "objectId",
      "predicate",
      "subjectId",
    ]);

    // Same edge again (by name) → resolves to the same entities, reinforces (not created).
    const second = await server.app.inject({
      method: "POST",
      url: "/api/knowledge/relationships",
      payload: { subject, predicate: "works at", object },
    });
    const secondBody = knowledge.AddRelationshipResponse.parse(second.json());
    expect(secondBody.created).toBe(false);
    expect(secondBody.subjectId).toBe(firstBody.subjectId);
    expect(secondBody.objectId).toBe(firstBody.objectId);
  });

  it("rejects a self-relationship (400)", async () => {
    const ref = { type: "person" as const, name: "Self Rel" };
    const res = await server.app.inject({
      method: "POST",
      url: "/api/knowledge/relationships",
      payload: { subject: ref, predicate: "knows", object: ref },
    });
    expect(res.statusCode).toBe(400);
  });
});
