import { describe, expect, it } from "vitest";
import { buildContextPack } from "../src/chat/retrieval.js";
import { openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { reciprocalRankFusion } from "../src/embedding/vectors.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

async function store() {
  const db = openDatabase(":memory:");
  return { store: new KnowledgeStore(db), embedder: new HashEmbedder() };
}

describe("hybrid retrieval", () => {
  it("surfaces a curated fact by content even when the query never names the entity", async () => {
    const { store: s, embedder } = await store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const sourceId = s.createSource({ type: "text", title: "Notes", content: "..." });
    const [vec] = await embedder.embed(["Dana lives in Berlin."]);
    s.insertObservation({
      entityId: dana.id,
      text: "Dana lives in Berlin.",
      sourceId,
      embedding: vec!,
      confidence: 0.8,
    });

    // The query talks about Berlin, not "Dana" — the old literal-substring path
    // would have missed this fact entirely.
    const pack = await buildContextPack(s, embedder, "anything new about Berlin?");

    expect(pack.text).toContain("Dana lives in Berlin.");
    expect(pack.matchedEntities.map((e) => e.name)).toContain("Dana");
    expect(pack.sources.map((src) => src.title)).toContain("Notes");
  });

  it("retrieves the compiled wiki prose, not just raw chunks", async () => {
    const { store: s, embedder } = await store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const [vec] = await embedder.embed(["Dana is a designer working on Orion."]);
    s.upsertWikiPage(dana.id, "Dana is a designer working on Orion.", vec!);

    const pack = await buildContextPack(s, embedder, "who is the designer?");

    expect(pack.text).toContain("### Wiki: Dana");
    expect(pack.text).toContain("designer");
  });
});

describe("source-count provenance", () => {
  it("confidence tracks distinct sources, not repeat mentions", async () => {
    const { store: s } = await store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const a = s.createSource({ type: "text", title: "A", content: "." });
    const b = s.createSource({ type: "text", title: "B", content: "." });

    const obs = s.insertObservation({ entityId: dana.id, text: "Dana leads Orion.", sourceId: a });
    expect(s.observationSourceCount(obs)).toBe(1);
    expect(s.getObservation(obs)!.confidence).toBeCloseTo(0.5, 5);

    // the same source restating the fact must not inflate confidence
    s.reinforceObservation(obs, a);
    expect(s.observationSourceCount(obs)).toBe(1);
    expect(s.getObservation(obs)!.confidence).toBeCloseTo(0.5, 5);

    // a genuinely new source corroborates it
    s.reinforceObservation(obs, b);
    expect(s.observationSourceCount(obs)).toBe(2);
    expect(s.getObservation(obs)!.confidence).toBeCloseTo(0.65, 5);
  });
});

describe("reciprocalRankFusion", () => {
  it("rewards items ranked highly across lists", async () => {
    // id 2 appears near the top of both lists; id 1 only tops the first.
    const fused = reciprocalRankFusion([
      [1, 2, 3],
      [2, 4, 1],
    ]);
    expect(fused[0]).toBe(2);
  });
});
