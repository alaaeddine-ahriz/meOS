import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { applyResolution, proposeResolution } from "../src/memory/resolution.js";

function store() {
  return new KnowledgeStore(openDatabase(":memory:"));
}

describe("contradiction resolution", () => {
  it("proposes superseding the older, weaker claim", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const old = s.createSource({ type: "file", title: "Old", content: "." });
    const fresh = s.createSource({ type: "file", title: "New", content: "." });

    const a = s.insertObservation({
      entityId: dana.id,
      text: "Dana lives in Paris.",
      sourceId: old,
      confidence: 0.6,
      validFrom: "2019-01-01",
    });
    const b = s.insertObservation({
      entityId: dana.id,
      text: "Dana lives in Berlin.",
      sourceId: fresh,
      confidence: 0.8,
      validFrom: "2024-01-01",
    });
    const cId = s.createContradiction(a, b, "conflicting cities");

    const proposal = proposeResolution(s, cId)!;
    // b is newer + higher confidence → supersede a
    expect(proposal.suggested).toBe("supersede_a");
    expect(proposal.rationale).toContain("more recent");
  });

  it("applies a supersede resolution: loser retired, contradiction closed", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const a = s.insertObservation({
      entityId: dana.id,
      text: "Dana lives in Paris.",
      confidence: 0.6,
      validFrom: "2019-01-01",
    });
    const b = s.insertObservation({
      entityId: dana.id,
      text: "Dana lives in Berlin.",
      confidence: 0.8,
      validFrom: "2024-01-01",
    });
    const cId = s.createContradiction(a, b);

    expect(applyResolution(s, cId, "supersede_a")).toBe(true);
    expect(s.getObservation(a)!.status).toBe("superseded");
    expect(s.getObservation(a)!.superseded_by).toBe(b);
    expect(s.getObservation(b)!.status).toBe("active");
    expect(s.unresolvedContradictions()).toHaveLength(0);
  });

  it("keep_both closes the contradiction without retiring either claim", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const a = s.insertObservation({ entityId: dana.id, text: "Dana works in design." });
    const b = s.insertObservation({ entityId: dana.id, text: "Dana works in research." });
    const cId = s.createContradiction(a, b);

    expect(applyResolution(s, cId, "keep_both")).toBe(true);
    expect(s.getObservation(a)!.status).toBe("active");
    expect(s.getObservation(b)!.status).toBe("active");
    expect(s.unresolvedContradictions()).toHaveLength(0);
    // already resolved → no-op
    expect(applyResolution(s, cId, "supersede_a")).toBe(false);
  });

  it("suggests keep_both when the two claims are too close to call", () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const a = s.insertObservation({
      entityId: dana.id,
      text: "A",
      confidence: 0.7,
      validFrom: "2024-01-01",
    });
    const b = s.insertObservation({
      entityId: dana.id,
      text: "B",
      confidence: 0.7,
      validFrom: "2024-01-01",
    });
    const cId = s.createContradiction(a, b);

    expect(proposeResolution(s, cId)!.suggested).toBe("keep_both");
  });
});
