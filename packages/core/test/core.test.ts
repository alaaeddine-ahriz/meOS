import { describe, expect, it } from "vitest";
import { z } from "zod";
import { openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { cosineSimilarity, deserializeVector, serializeVector } from "../src/embedding/vectors.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
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
    expect(tables).toContain("watched_folders");
    expect(tables).toContain("ingested_files");
    // all migrations applied; exact count changes as the schema grows
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(3);
    db.close();
  });
});

describe("watched folders", () => {
  it("registers folders and tracks absorbed file versions", () => {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);

    const folder = store.addWatchedFolder("/tmp/notes");
    expect(store.addWatchedFolder("/tmp/notes").id).toBe(folder.id); // idempotent
    expect(store.listWatchedFolders().map((f) => f.path)).toEqual(["/tmp/notes"]);

    // a file version (path + mtime + size) is absorbed exactly once
    expect(store.fileNeedsIngest("/tmp/notes/a.md", 1000.7, 5)).toBe(true);
    store.recordIngestedFile("/tmp/notes/a.md", 1000.7, 5);
    expect(store.fileNeedsIngest("/tmp/notes/a.md", 1000.7, 5)).toBe(false);
    expect(store.fileNeedsIngest("/tmp/notes/a.md", 2000, 5)).toBe(true); // edited

    expect(store.removeWatchedFolder(folder.id)).toBe("/tmp/notes");
    expect(store.removeWatchedFolder(folder.id)).toBeUndefined();
    expect(store.listWatchedFolders()).toHaveLength(0);
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
