import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { buildContextPack } from "../src/chat/retrieval.js";
import { IngestionPipeline } from "../src/ingest/pipeline.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { WikiWriter } from "../src/wiki/writer.js";
import { adaDocument, makeEmbedder, makeExtractionStub } from "./fixtures/index.js";

/**
 * Core-level e2e smoke (#21): the offline ingest -> retrieve journey, driven
 * end to end through the real {@link IngestionPipeline} and retrieval, with a
 * {@link makeExtractionStub} LLM and a deterministic hash embedder. No network,
 * no real model. This is the "ingest a document, then ask a question" journey
 * exercised at the library layer; the server suite covers the same shape over
 * HTTP. Built on the shared fixtures so the setup is not duplicated per suite.
 */
describe("e2e: ingest a document then retrieve it (offline)", () => {
  let db: MeosDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-e2e-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("turns a document into retrievable knowledge", async () => {
    const store = new KnowledgeStore(db);
    const embedder = makeEmbedder();
    const llm = makeExtractionStub();
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({ store, llm, embedder, wiki });

    // 1. Ingest a document.
    const outcome = await pipeline.ingest(adaDocument);
    expect(outcome.status).toBe("done");

    // 2. The document became knowledge: entities + observations + a wiki page.
    const entities = store.listEntities();
    expect(entities.map((e) => e.name).sort()).toEqual(["Ada Lovelace", "Analytical Engine"]);
    const ada = store.findEntityByName("Ada Lovelace")!;
    expect(store.activeObservations(ada.id).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmpDir, "person", `${ada.slug}.md`))).toBe(true);

    // 3. "Ask a question": retrieval surfaces the ingested entity for a query.
    const pack = await buildContextPack(store, embedder, "Tell me about Ada Lovelace");
    expect(pack.matchedEntities.map((e) => e.name)).toContain("Ada Lovelace");
  });
});
