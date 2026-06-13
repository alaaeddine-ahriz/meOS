import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { initialConfidence } from "../src/memory/confidence.js";
import { classifyMemoryTier, reclassifyMemoryTiers } from "../src/memory/memory-tiers.js";
import { runRetention } from "../src/memory/retention.js";
import { expireStaleValidity } from "../src/memory/supersession.js";

function store() {
  return new KnowledgeStore(openDatabase(":memory:"));
}

describe("initial confidence", () => {
  it("discounts the extractor's confidence by source quality", () => {
    expect(initialConfidence(0.8, "file")).toBeCloseTo(0.8, 5); // trusted document
    expect(initialConfidence(0.8, "conversation")).toBeCloseTo(0.68, 5); // 0.8 * 0.85
    expect(initialConfidence(0.5, undefined)).toBeCloseTo(0.5, 5);
  });
});

describe("memory tier classification", () => {
  it("places claims on the abstraction ladder by kind and corroboration", () => {
    expect(classifyMemoryTier({ kind: "procedure", sourceCount: 1 })).toBe("procedural");
    expect(classifyMemoryTier({ kind: "fact", sourceCount: 2 })).toBe("semantic");
    expect(classifyMemoryTier({ kind: "fact", sourceCount: 1 })).toBe("working");
    expect(classifyMemoryTier({ kind: "event", sourceCount: 1 })).toBe("episodic");
    expect(classifyMemoryTier({ kind: "fact", sourceType: "conversation", sourceCount: 1 })).toBe("episodic");
  });

  it("promotes a fact to semantic once a second source corroborates it", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const a = s.createSource({ type: "file", title: "A", content: "." });
    const b = s.createSource({ type: "file", title: "B", content: "." });

    const obs = s.insertObservation({ entityId: dana.id, text: "Dana leads Orion.", sourceId: a, kind: "fact" });
    expect(s.getObservation(obs)!.memory_tier).toBe("working");

    s.recordObservationSource(obs, b); // a second independent source
    expect(reclassifyMemoryTiers(s)).toBe(1);
    expect(s.getObservation(obs)!.memory_tier).toBe("semantic");
  });
});

describe("time-based supersession", () => {
  it("retires claims whose validity window has passed and flags their page", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    s.clearWikiStale(dana.id);
    const src = s.createSource({ type: "file", title: "Roles", content: "." });
    const obs = s.insertObservation({
      entityId: dana.id,
      text: "Dana is interim lead until 2020.",
      sourceId: src,
      validUntil: "2020-01-01",
    });

    expect(expireStaleValidity(s)).toBe(1);
    expect(s.getObservation(obs)!.status).toBe("superseded");
    expect(s.activeObservations(dana.id)).toHaveLength(0);
    expect(s.getEntity(dana.id)!.wiki_stale).toBe(1); // page queued for rewrite
  });
});

describe("retention pass", () => {
  it("decays, promotes, expires, and re-tiers in one call", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const src = s.createSource({ type: "file", title: "Src", content: "." });
    const corroborated = s.insertObservation({
      entityId: dana.id,
      text: "Dana works on Orion.",
      sourceId: src,
      confidence: 0.9,
      kind: "fact",
    });
    s.recordObservationSource(corroborated, s.createSource({ type: "file", title: "Src2", content: "." }));

    const report = runRetention(s);
    expect(report.promoted).toBe(1); // 0.9 >= promote threshold
    expect(report.retiered).toBe(1); // working -> semantic (two sources)
    expect(s.getObservation(corroborated)!.tier).toBe("fact");
    expect(s.getObservation(corroborated)!.memory_tier).toBe("semantic");
  });
});
