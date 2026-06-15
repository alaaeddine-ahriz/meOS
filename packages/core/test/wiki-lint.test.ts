import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { healWiki } from "../src/wiki/self-healing.js";
import { lintPage } from "../src/wiki/wiki-lint.js";

function store() {
  return new KnowledgeStore(openDatabase(":memory:"));
}

describe("wiki lint", () => {
  it("scores a grounded, connected, cited page highly", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const orion = s.createEntity({ type: "project", name: "Orion" });
    s.upsertRelationship(dana.id, orion.id, "works on");
    const src = s.createSource({ type: "file", title: "Notes", content: "." });
    s.insertObservation({
      entityId: dana.id,
      text: "Dana leads Orion.",
      sourceId: src,
      confidence: 0.9,
    });

    const result = lintPage(s, dana.id, "Dana leads [[Orion]].");
    expect(result.issues).toHaveLength(0);
    expect(result.quality).toBeGreaterThan(0.9);
  });

  it("flags a broken link as auto-fixable", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const src = s.createSource({ type: "file", title: "N", content: "." });
    s.upsertRelationship(dana.id, dana.id, "self"); // avoid orphan; isolate the link issue
    s.insertObservation({ entityId: dana.id, text: "x", sourceId: src, confidence: 0.9 });

    const result = lintPage(s, dana.id, "Dana collaborates with [[Ghost]].");
    const broken = result.issues.find((i) => i.code === "broken_link");
    expect(broken?.severity).toBe("auto");
  });

  it("flags uncited claims for review and lowers the score", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    s.insertObservation({ entityId: dana.id, text: "Dana likes tea." }); // no source

    const result = lintPage(s, dana.id, "Dana likes tea.");
    expect(result.issues.map((i) => i.code)).toContain("missing_citations");
    expect(result.quality).toBeLessThan(0.7);
  });
});

describe("healWiki", () => {
  it("persists scores, flags auto-fixable pages, and reports low-quality ones", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    s.clearWikiStale(dana.id);
    // a broken link + orphan + uncited → auto-fixable and low quality
    s.upsertWikiPage(dana.id, "Dana works with [[Nobody]].");
    s.insertObservation({ entityId: dana.id, text: "Dana works with Nobody." });

    const report = healWiki(s);
    expect(report.flaggedForRepair).toBe(1);
    expect(s.getEntity(dana.id)!.wiki_stale).toBe(1);
    expect(report.lowQuality.map((p) => p.entity_id)).toContain(dana.id);
    expect(report.meanQuality).not.toBeNull();
  });
});
