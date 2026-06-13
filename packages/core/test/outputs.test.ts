import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import {
  contradictionReport,
  decisionBrief,
  dependencyGraph,
  entityTimeline,
  meetingBrief,
} from "../src/outputs.js";

function seeded() {
  const s = new KnowledgeStore(openDatabase(":memory:"));
  const atlas = s.createEntity({ type: "project", name: "Atlas" });
  const ai = s.createEntity({ type: "concept", name: "AI Service" });
  s.upsertRelationship(atlas.id, ai.id, "depends on");
  s.insertObservation({ entityId: atlas.id, text: "Chose Postgres for Atlas.", kind: "decision", validFrom: "2024-02-01", confidence: 0.9 });
  s.insertObservation({ entityId: atlas.id, text: "Atlas kicked off.", kind: "event", validFrom: "2024-01-01", confidence: 0.8 });
  s.insertObservation({ entityId: atlas.id, text: "Atlas must ship by Q3.", kind: "requirement", confidence: 0.8 });
  return { s, atlas, ai };
}

describe("output modes", () => {
  it("decision brief lists decisions with dates", () => {
    const { s } = seeded();
    const md = decisionBrief(s);
    expect(md).toContain("# Decision brief");
    expect(md).toContain("Chose Postgres for Atlas.");
    expect(md).toContain("2024-02-01");
  });

  it("timeline orders an entity's dated facts chronologically", () => {
    const { s, atlas } = seeded();
    const md = entityTimeline(s, atlas.id);
    expect(md.indexOf("Atlas kicked off")).toBeLessThan(md.indexOf("Chose Postgres"));
  });

  it("dependency graph renders mermaid and an edge list", () => {
    const { s, atlas } = seeded();
    const md = dependencyGraph(s, atlas.id);
    expect(md).toContain("```mermaid");
    expect(md).toContain("depends on");
    expect(md).toContain("AI Service");
  });

  it("meeting brief groups facts, decisions, and connections", () => {
    const { s, atlas } = seeded();
    const md = meetingBrief(s, atlas.id);
    expect(md).toContain("# Meeting brief — Atlas");
    expect(md).toContain("## Decisions");
    expect(md).toContain("must ship by Q3");
    expect(md).toContain("## Connections");
  });

  it("contradiction report includes a suggested resolution", () => {
    const { s, atlas } = seeded();
    const a = s.insertObservation({ entityId: atlas.id, text: "Atlas uses MySQL.", confidence: 0.5, validFrom: "2023-01-01" });
    const b = s.insertObservation({ entityId: atlas.id, text: "Atlas uses Postgres.", confidence: 0.9, validFrom: "2024-06-01" });
    s.createContradiction(a, b, "db mismatch");

    const md = contradictionReport(s);
    expect(md).toContain("# Contradiction report");
    expect(md).toContain("**Suggested:**");
  });

  it("excludes private/secret claims from outputs", () => {
    const { s, atlas } = seeded();
    s.insertObservation({ entityId: atlas.id, text: "Owner email is x@y.com.", kind: "fact", sensitivity: "private" });
    expect(meetingBrief(s, atlas.id)).not.toContain("x@y.com");
  });
});
