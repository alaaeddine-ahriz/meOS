import { describe, expect, it } from "vitest";
import { buildContextPack } from "../src/chat/retrieval.js";
import { classifyIntent } from "../src/chat/query-planner.js";
import { openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

function store() {
  return new KnowledgeStore(openDatabase(":memory:"));
}

describe("query planner", () => {
  it("classifies intent from the phrasing", () => {
    expect(classifyIntent("Where did I mention Appwrite?")).toBe("find_source");
    expect(classifyIntent("What changed about MeOS recently?")).toBe("trace_timeline");
    expect(classifyIntent("Are there any contradictions about Dana?")).toBe("find_contradictions");
    expect(classifyIntent("Compare Supabase versus Appwrite")).toBe("compare");
    expect(classifyIntent("Tell me about Project Orion")).toBe("summarize_entity");
    expect(classifyIntent("Remember that Dana left the company")).toBe("update_memory");
    expect(classifyIntent("Draft a decision brief on the backend")).toBe("generate_output");
    expect(classifyIntent("Who leads Orion?")).toBe("ask_fact");
  });
});

describe("intent-routed retrieval", () => {
  it("orders facts chronologically for a timeline question", async () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    // recorded high-confidence-first, but dated out of order
    s.insertObservation({
      entityId: dana.id,
      text: "Dana was promoted to lead.",
      validFrom: "2022-05-01",
      confidence: 0.9,
    });
    s.insertObservation({
      entityId: dana.id,
      text: "Dana joined the team.",
      validFrom: "2020-01-01",
      confidence: 0.5,
    });

    const pack = await buildContextPack(
      s,
      new HashEmbedder(),
      "what is the timeline of Dana's history?",
    );

    expect(pack.intent).toBe("trace_timeline");
    // every fact leads with its date so the model can place and weigh it
    expect(pack.text).toContain("[2020-01-01, confidence 0.50] Dana joined the team.");
    // earliest event appears before the later one
    expect(pack.text.indexOf("Dana joined")).toBeLessThan(pack.text.indexOf("Dana was promoted"));
  });

  it("surfaces open contradictions when that is the question", async () => {
    const s = store();
    const dana = s.createEntity({ type: "person", name: "Dana" });
    const a = s.insertObservation({ entityId: dana.id, text: "Dana lives in Paris." });
    const b = s.insertObservation({ entityId: dana.id, text: "Dana lives in Berlin." });
    s.createContradiction(a, b, "conflicting cities");

    const pack = await buildContextPack(s, new HashEmbedder(), "any contradictions about Dana?");

    expect(pack.intent).toBe("find_contradictions");
    expect(pack.text).toContain("### Open contradictions:");
    expect(pack.text).toContain("conflicting cities");
  });
});
