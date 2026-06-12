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
      summary: "Mathematician collaborating on the Analytical Engine.",
    },
    {
      name: "Analytical Engine",
      type: "project",
      aliases: [],
      summary: "A proposed mechanical general-purpose computer.",
    },
  ],
  relationships: [{ from: "Ada Lovelace", to: "Analytical Engine", label: "works on" }],
  observations: [
    { entity: "Ada Lovelace", text: "Ada Lovelace wrote the first published algorithm." },
    { entity: "Analytical Engine", text: "The Analytical Engine uses punched cards for input." },
  ],
};

function makeStub() {
  return new StubLlmClient({
    onStructured: (request) => {
      if (request.schemaName === "knowledge_extraction") return sampleExtraction;
      if (request.schemaName === "wiki_page") {
        return {
          summary: "A generated one-line summary.",
          body: "A page about this entity, related to [[Ada Lovelace]].",
        };
      }
      throw new Error(`Unexpected structured request: ${request.schemaName}`);
    },
  });
}

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
    expect(store.activeObservations(ada.id)).toHaveLength(1);
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
    expect(observations).toHaveLength(1);
    expect(observations[0]!.confidence).toBeCloseTo(0.65, 5);
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
});
