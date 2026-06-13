import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import type { Extraction } from "../src/extract/schema.js";
import { mergeExtraction } from "../src/knowledge/merge.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { containsSecret, redactSecrets } from "../src/memory/privacy.js";

function store() {
  return new KnowledgeStore(openDatabase(":memory:"));
}

function extraction(observations: Extraction["observations"]): Extraction {
  return { entities: [{ name: "Dana", type: "person", aliases: [], summary: "" }], relationships: [], observations };
}

describe("rich-claim provenance", () => {
  it("records kind, confidence, validity, and the quote's char span in the source", async () => {
    const s = store();
    const embedder = new HashEmbedder();
    const sourceText = "Project log. Dana joined the Orion team in March 2024. End.";
    const sourceId = s.createSource({ type: "text", title: "Log", content: sourceText });

    const merge = await mergeExtraction(
      s,
      embedder,
      extraction([
        {
          entity: "Dana",
          claim: "Dana joined the Orion team in March 2024.",
          kind: "event",
          sourceQuote: "Dana joined the Orion team in March 2024.",
          validFrom: "2024-03-01",
          validUntil: null,
          confidence: 0.8,
          sensitivity: "normal",
        },
      ]),
      sourceId,
      sourceText,
    );

    const obs = s.getObservation(merge.newObservationIds[0]!)!;
    expect(obs.kind).toBe("event");
    expect(obs.confidence).toBeCloseTo(0.8, 5);
    expect(obs.valid_from).toBe("2024-03-01");
    // the char span points back at the exact supporting sentence
    expect(sourceText.slice(obs.char_start!, obs.char_end!)).toBe("Dana joined the Orion team in March 2024.");
  });
});

describe("privacy at ingest", () => {
  it("redacts a credential from stored text and marks the claim secret", async () => {
    const s = store();
    const embedder = new HashEmbedder();
    const secret = "sk-ant-api03ABCDEFGHIJKLMNOPQRSTUV";
    const sourceId = s.createSource({ type: "text", title: "Creds", content: "." });
    const merge = await mergeExtraction(
      s,
      embedder,
      extraction([
        {
          entity: "Dana",
          claim: `Dana's API key is ${secret}.`,
          kind: "fact",
          sourceQuote: null,
          validFrom: null,
          validUntil: null,
          confidence: 0.9,
          // the extractor mislabels it; detection must override to "secret"
          sensitivity: "normal",
        },
      ]),
      sourceId,
    );

    const obs = s.getObservation(merge.newObservationIds[0]!)!;
    expect(obs.sensitivity).toBe("secret");
    expect(obs.text).not.toContain(secret);
    expect(obs.text).toContain("[REDACTED]");
    // sensitive claims are filtered out of the material the wiki writer sees
    expect(s.activeObservations(obs.entity_id).filter((o) => o.sensitivity === "normal")).toHaveLength(0);
  });

  it("detects and redacts common secret shapes, leaving prose intact", () => {
    expect(containsSecret("here is AKIAIOSFODNN7EXAMPLE for aws")).toBe(true);
    expect(containsSecret("just a normal sentence about Berlin")).toBe(false);
    expect(redactSecrets("token=ghp_0123456789012345678901234567890123456 done")).toContain("[REDACTED]");
    expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
  });
});
