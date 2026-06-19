import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { IngestionPipeline } from "../src/ingest/pipeline.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import type { LlmClient, StructuredRequest } from "../src/llm/types.js";
import { WikiWriter } from "../src/wiki/writer.js";
import { makeExtractionStub } from "./fixtures/index.js";

/**
 * Hash-unchanged short-circuit. Re-ingesting identical content must NOT re-run
 * the expensive LLM stages — extraction is the costly resource we're protecting.
 * The pipeline opens a new revision only when it actually reprocesses, so a
 * skipped re-ingest leaves the revision history untouched; a real edit advances
 * it. We also count the extractor calls directly to prove no LLM work happened.
 */
describe("IngestionPipeline hash-unchanged skip", () => {
  let db: MeosDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-hash-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Wrap the extraction stub so we can count how many documents it extracts. */
  function countingLlm(counter: { extractions: number }): LlmClient {
    const inner = makeExtractionStub();
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "completeStructured") {
          return <T>(request: StructuredRequest<T>) => {
            counter.extractions++;
            return inner.completeStructured(request);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  function makePipeline(counter: { extractions: number }) {
    const store = new KnowledgeStore(db);
    const llm = countingLlm(counter);
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({ store, llm, embedder: new HashEmbedder(), wiki });
    return { store, pipeline };
  }

  const fileInput = (text: string) => ({
    kind: "file" as const,
    filename: "notes.txt",
    path: "/vault/notes.txt",
    buffer: Buffer.from(text, "utf8"),
  });

  it("skips reprocessing when re-ingesting identical content", async () => {
    const counter = { extractions: 0 };
    const { store, pipeline } = makePipeline(counter);
    const text = "Notes about Ada Lovelace and the Analytical Engine.";

    const first = await pipeline.ingest(fileInput(text));
    expect(first.status).toBe("done");
    const extractionsAfterFirst = counter.extractions;
    expect(extractionsAfterFirst).toBeGreaterThan(0); // it really extracted once
    expect(store.revisionsForSource(first.sourceId!)).toHaveLength(1);

    // Re-ingest the exact same bytes (e.g. a metadata-only touch / re-upload).
    const second = await pipeline.ingest(fileInput(text));
    expect(second.status).toBe("done");
    expect(second.sourceId).toBe(first.sourceId);
    // Same active revision returned — NO new revision was opened...
    expect(second.sourceRevisionId).toBe(first.sourceRevisionId);
    expect(store.revisionsForSource(first.sourceId!)).toHaveLength(1);
    // ...and crucially, the extractor was never called again.
    expect(counter.extractions).toBe(extractionsAfterFirst);

    const inbox = store.listInbox();
    expect(inbox[0]!.status).toBe("done");
    expect(inbox[0]!.detail ?? "").toContain("Unchanged");
  });

  it("still reprocesses when the content actually changes", async () => {
    const counter = { extractions: 0 };
    const { store, pipeline } = makePipeline(counter);

    const first = await pipeline.ingest(fileInput("Notes about Ada Lovelace."));
    const extractionsAfterFirst = counter.extractions;

    const edited = await pipeline.ingest(
      fileInput("Notes about Ada Lovelace and Charles Babbage."),
    );
    expect(edited.sourceId).toBe(first.sourceId);
    // A genuine edit advances the revision history and re-runs extraction.
    expect(edited.sourceRevisionId).not.toBe(first.sourceRevisionId);
    expect(store.revisionsForSource(first.sourceId!)).toHaveLength(2);
    expect(counter.extractions).toBeGreaterThan(extractionsAfterFirst);
  });
});
