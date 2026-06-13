import { describe, expect, it } from "vitest";
import { buildContextPack } from "../src/chat/retrieval.js";
import { openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

function store() {
  return new KnowledgeStore(openDatabase(":memory:"));
}

describe("relationship lifecycle", () => {
  it("raises edge confidence per distinct source, never per repeat mention", () => {
    const s = store();
    const x = s.createEntity({ type: "project", name: "Project X" });
    const ai = s.createEntity({ type: "concept", name: "AI Service" });
    const a = s.createSource({ type: "file", title: "A", content: "." });
    const b = s.createSource({ type: "file", title: "B", content: "." });

    expect(s.upsertRelationship(x.id, ai.id, "uses", a)).toBe(true); // created
    expect(s.relationshipsFor(x.id)[0]!.confidence).toBeCloseTo(0.5, 5);

    expect(s.upsertRelationship(x.id, ai.id, "uses", a)).toBe(false); // same source
    expect(s.relationshipsFor(x.id)[0]!.confidence).toBeCloseTo(0.5, 5);

    expect(s.upsertRelationship(x.id, ai.id, "uses", b)).toBe(false); // new source
    expect(s.relationshipsFor(x.id)[0]!.confidence).toBeCloseTo(0.65, 5);
  });
});

describe("graph traversal", () => {
  it("returns entities one hop from the seeds, excluding the seeds", () => {
    const s = store();
    const x = s.createEntity({ type: "project", name: "X" });
    const ai = s.createEntity({ type: "concept", name: "AI" });
    const db = s.createEntity({ type: "concept", name: "DB" });
    s.upsertRelationship(x.id, ai.id, "uses");
    s.upsertRelationship(x.id, db.id, "uses");

    const neighbors = s.graphNeighbors([x.id]);
    expect(neighbors.sort()).toEqual([ai.id, db.id].sort());
    expect(neighbors).not.toContain(x.id);
  });
});

describe("graph-aware retrieval", () => {
  it("surfaces downstream-impacted entities that share no query text", async () => {
    const s = store();
    const embedder = new HashEmbedder();
    const ai = s.createEntity({ type: "concept", name: "AI Service" });
    const project = s.createEntity({ type: "project", name: "Project Atlas" });
    // Atlas depends on the AI Service, but its only fact is unrelated to the query.
    s.upsertRelationship(project.id, ai.id, "depends on");
    const src = s.createSource({ type: "file", title: "Atlas", content: "." });
    const [vec] = await embedder.embed(["Project Atlas ships in Q3."]);
    s.insertObservation({ entityId: project.id, text: "Project Atlas ships in Q3.", sourceId: src, embedding: vec! });

    const pack = await buildContextPack(s, embedder, "what depends on the AI Service?");

    // AI Service matches literally; Atlas is pulled in purely via the graph edge.
    expect(pack.matchedEntities.map((e) => e.name)).toContain("AI Service");
    expect(pack.matchedEntities.map((e) => e.name)).toContain("Project Atlas");
    expect(pack.text).toContain("### Entity: Project Atlas");
  });
});
