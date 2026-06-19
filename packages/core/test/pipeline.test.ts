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
import { adaExtraction as sampleExtraction, makeExtractionStub } from "./fixtures/index.js";

// The canonical extraction + ingest stub now live in the shared fixtures (#21),
// so suites stop re-declaring them; this alias keeps the cases below unchanged.
const makeStub = makeExtractionStub;

describe("IngestionPipeline", () => {
  let db: MeosDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-test-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePipeline() {
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const llm = makeStub();
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({ store, llm, embedder, wiki });
    return { store, pipeline, wiki };
  }

  it("ingests text into entities, observations, relationships, and wiki pages", async () => {
    const { store, pipeline } = makePipeline();

    const outcome = await pipeline.ingest({
      kind: "text",
      title: "History notes",
      text: "Notes about Ada Lovelace and the Analytical Engine.",
    });

    expect(outcome.status).toBe("done");

    const entities = store.listEntities();
    expect(entities.map((e) => e.name).sort()).toEqual(["Ada Lovelace", "Analytical Engine"]);

    const ada = store.findEntityByName("Ada")!; // resolved via alias
    expect(ada.name).toBe("Ada Lovelace");
    expect(store.activeObservations(ada.id)).toHaveLength(3);
    expect(store.relationshipsFor(ada.id)).toHaveLength(1);

    // wiki page written to disk with frontmatter and generated body
    const pagePath = path.join(tmpDir, "person", `${ada.slug}.md`);
    const page = fs.readFileSync(pagePath, "utf-8");
    expect(page).toContain("entity_id:");
    expect(page).toContain("[[Ada Lovelace]]");

    // summary stored back onto the entity, staleness cleared
    expect(store.getEntity(ada.id)!.summary).toBe("A generated one-line summary.");
    expect(store.staleEntities()).toHaveLength(0);

    const inbox = store.listInbox();
    expect(inbox[0]!.status).toBe("done");
  });

  it("reinforces near-duplicate observations instead of duplicating them", async () => {
    const { store, pipeline } = makePipeline();

    await pipeline.ingest({ kind: "text", title: "First", text: "First capture." });
    await pipeline.ingest({ kind: "text", title: "Second", text: "Second capture, same facts." });

    const ada = store.findEntityByName("Ada Lovelace")!;
    const observations = store.activeObservations(ada.id);
    // The three Ada facts reinforce rather than duplicate: re-ingesting the same
    // capture leaves three observations (not six), each bumped in confidence.
    expect(observations).toHaveLength(3);
    for (const o of observations) expect(o.confidence).toBeCloseTo(0.65, 5);
  });

  it("flags unsupported files in the inbox instead of failing", async () => {
    const { store, pipeline } = makePipeline();
    const outcome = await pipeline.ingest({
      kind: "file",
      filename: "photo.heic",
      buffer: Buffer.from([0x00]),
    });
    expect(outcome.status).toBe("unsupported");
    expect(store.listInbox()[0]!.status).toBe("unsupported");
  });

  it("reads images through the LLM and ingests the transcription", async () => {
    const store = new KnowledgeStore(db);
    const llm = new StubLlmClient({
      onComplete: () => "Whiteboard notes about Ada Lovelace and the Analytical Engine.",
      onStructured: (request) => {
        if (request.schemaName === "knowledge_extraction") return sampleExtraction;
        return { summary: "A generated one-line summary.", body: "A page." };
      },
    });
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({ store, llm, embedder: new HashEmbedder(), wiki });

    const outcome = await pipeline.ingest({
      kind: "file",
      filename: "whiteboard.png",
      buffer: Buffer.from("not-a-real-png"),
    });

    expect(outcome.status).toBe("done");
    // The vision call carried the image bytes...
    const visionCall = llm.requests.find((r) => r.kind === "complete")!;
    const content = visionCall.request.messages[0]!.content;
    expect(Array.isArray(content) && content.some((p) => p.type === "image")).toBe(true);
    // ...and the stored source is the transcription, not the binary.
    const source = db
      .prepare("SELECT content FROM sources WHERE id = ?")
      .get(outcome.sourceId!) as { content: string };
    expect(source.content).toContain("Whiteboard notes");
  });

  it("defers wiki regeneration when a scheduler is provided", async () => {
    const store = new KnowledgeStore(db);
    const llm = makeStub();
    const wiki = new WikiWriter(store, llm, tmpDir);
    let scheduled = 0;
    const pipeline = new IngestionPipeline({
      store,
      llm,
      embedder: new HashEmbedder(),
      wiki,
      scheduleWikiRefresh: () => {
        scheduled++;
      },
    });

    const outcome = await pipeline.ingest({ kind: "text", title: "Notes", text: "Ada Lovelace." });

    expect(outcome.status).toBe("done");
    expect(scheduled).toBe(1);
    // Pages stay stale until the deferred pass runs them.
    expect(store.staleEntities().length).toBeGreaterThan(0);
    await wiki.regenerateStale();
    expect(store.staleEntities()).toHaveLength(0);
  });
});
