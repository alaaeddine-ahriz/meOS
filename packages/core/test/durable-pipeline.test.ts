import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { IngestionPipeline } from "../src/ingest/pipeline.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { WikiWriter } from "../src/wiki/writer.js";

const sampleExtraction = {
  entities: [
    {
      name: "Ada Lovelace",
      type: "person",
      aliases: ["Ada"],
      summary: "Mathematician.",
    },
  ],
  relationships: [],
  observations: [
    {
      entity: "Ada Lovelace",
      claim: "Ada Lovelace wrote the first published algorithm.",
      kind: "fact",
      sourceQuote: "Ada Lovelace wrote the first published algorithm.",
      validFrom: null,
      validUntil: null,
      confidence: 0.5,
      sensitivity: "normal",
    },
  ],
};

/**
 * The transactional / resumable behaviour of the pipeline (#13): the search
 * index commits independently of semantic extraction, so a source becomes
 * searchable even when extraction fails — and re-running the extraction stage
 * later (no re-read, no re-chunk) is idempotent.
 */
describe("durable pipeline (extraction independence + idempotency)", () => {
  let db: MeosDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-durable-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build a pipeline whose extraction throws until `failExtraction` is flipped
   * off, so a single source can fail extraction then succeed on retry.
   */
  function makePipeline(state: { failExtraction: boolean }) {
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const llm = new StubLlmClient({
      onStructured: (request) => {
        if (request.schemaName === "knowledge_extraction") {
          if (state.failExtraction) throw new Error("LLM extraction outage");
          return sampleExtraction;
        }
        throw new Error(`Unexpected structured request: ${request.schemaName}`);
      },
      onAgent: async (request) => {
        const relPath = request.prompt.match(/target file is "([^"]+)"/)?.[1];
        if (!relPath) throw new Error("agent prompt did not name a target file");
        await request.sandbox.writeFiles([
          { path: relPath, content: "A page about [[Ada Lovelace]]." },
          { path: "SUMMARY.txt", content: "Summary." },
        ]);
        return "done";
      },
    });
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({ store, llm, embedder, wiki });
    return { store, pipeline };
  }

  it("keeps a source searchable when extraction fails, parking the revision incomplete", async () => {
    const state = { failExtraction: true };
    const { store, pipeline } = makePipeline(state);

    const outcome = await pipeline.ingest({
      kind: "text",
      title: "History notes",
      text: "Notes about Ada Lovelace and the Analytical Engine.",
    });

    // Searchable, but extraction failed → retryable, not a hard failure.
    expect(outcome.status).toBe("indexed");
    expect(outcome.sourceId).toBeDefined();
    expect(outcome.sourceRevisionId).toBeDefined();
    // The outcome carries the REAL failing stage + error (not a generic wrapper)
    // so the durable worker can surface them on the job in the Health view.
    expect(outcome.failedStage).toBe("extraction");
    expect(outcome.error).toBe("LLM extraction outage");

    // The search index landed: chunks exist for the source.
    expect(store.chunksForSource(outcome.sourceId!).length).toBeGreaterThan(0);
    // No semantic memory yet (extraction never ran).
    expect(store.listEntities()).toHaveLength(0);
    // The revision is parked incomplete so it doesn't look fully ingested.
    expect(store.getRevision(outcome.sourceRevisionId!)!.status).toBe("incomplete");
    // The inbox reflects the searchable-but-extraction-failed state.
    expect(store.listInbox()[0]!.status).toBe("extract-failed");
  });

  it("retries just the extraction stage from the stored revision, idempotently", async () => {
    const state = { failExtraction: true };
    const { store, pipeline } = makePipeline(state);

    const outcome = await pipeline.ingest({
      kind: "text",
      title: "History notes",
      text: "Notes about Ada Lovelace.",
    });
    expect(outcome.status).toBe("indexed");
    const chunkCountAfterIndex = store.chunksForSource(outcome.sourceId!).length;
    const inboxItemId = store.listInbox()[0]!.id;

    // The model recovers; retry extraction by source id — no re-read, no re-chunk.
    // The durable worker threads the inbox item through so the feed reflects it.
    state.failExtraction = false;
    const merge = await pipeline.retryExtractionForSource(outcome.sourceId!, inboxItemId);
    expect(merge).not.toBeNull();

    // Memory now landed and the revision is promoted back to active.
    const ada = store.findEntityByName("Ada Lovelace")!;
    expect(store.activeObservations(ada.id)).toHaveLength(1);
    expect(store.getRevision(outcome.sourceRevisionId!)!.status).toBe("active");
    // No chunks were re-created (idempotent index).
    expect(store.chunksForSource(outcome.sourceId!).length).toBe(chunkCountAfterIndex);
    expect(store.listInbox()[0]!.status).toBe("done");

    // Re-running extraction again reinforces rather than duplicating observations.
    await pipeline.retryExtractionForSource(outcome.sourceId!);
    expect(store.activeObservations(ada.id)).toHaveLength(1);
  });

  it("does not duplicate chunks when a full ingest re-runs on the same source", async () => {
    const state = { failExtraction: false };
    const { store, pipeline } = makePipeline(state);

    const first = await pipeline.ingest({ kind: "text", title: "Notes", text: "Ada Lovelace." });
    expect(first.status).toBe("done");
    const count = store.chunksForSource(first.sourceId!).length;

    // A re-ingest of the identical text re-indexes the same source without
    // doubling its chunk rows (the index commit clears prior chunks first).
    const again = await pipeline.ingest({ kind: "text", title: "Notes", text: "Ada Lovelace." });
    expect(again.status).toBe("done");
    expect(store.chunksForSource(again.sourceId!).length).toBe(count);
  });
});
