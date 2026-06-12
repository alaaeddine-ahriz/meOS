import { describe, expect, it } from "vitest";
import { z } from "zod";
import { openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { cosineSimilarity, deserializeVector, serializeVector } from "../src/embedding/vectors.js";
import { StubLlmClient } from "../src/llm/stub.js";

describe("database", () => {
  it("opens an in-memory database and applies migrations", () => {
    const db = openDatabase(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toContain("entities");
    expect(tables).toContain("observations");
    expect(tables).toContain("contradictions");
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    db.close();
  });
});

describe("HashEmbedder", () => {
  it("is deterministic and ranks overlapping text higher", async () => {
    const embedder = new HashEmbedder();
    const [a1, a2, b] = await embedder.embed([
      "the quarterly project review",
      "the quarterly project review",
      "completely unrelated topic about gardening",
    ]);
    expect(cosineSimilarity(a1!, a2!)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(a1!, b!)).toBeLessThan(0.5);
  });

  it("round-trips through blob serialization", async () => {
    const embedder = new HashEmbedder();
    const [vector] = await embedder.embed(["hello world"]);
    const restored = deserializeVector(serializeVector(vector!));
    expect(Array.from(restored)).toEqual(Array.from(vector!));
  });
});

describe("StubLlmClient", () => {
  it("validates structured responses against the schema", async () => {
    const schema = z.object({ name: z.string() });
    const stub = new StubLlmClient({ onStructured: () => ({ name: "Ada" }) });
    const result = await stub.completeStructured({
      messages: [{ role: "user", content: "extract" }],
      schema,
      schemaName: "test",
    });
    expect(result.name).toBe("Ada");

    const bad = new StubLlmClient({ onStructured: () => ({ wrong: true }) });
    await expect(
      bad.completeStructured({
        messages: [{ role: "user", content: "extract" }],
        schema,
        schemaName: "test",
      }),
    ).rejects.toThrow();
  });
});
