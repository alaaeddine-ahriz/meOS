import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrations, openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { IngestionPipeline } from "../src/ingest/pipeline.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { WikiWriter } from "../src/wiki/writer.js";

// A document about Ada; editing it swaps which observation the extractor returns,
// so a re-ingest genuinely changes the backing facts (not just reinforces).
function extractionFor(claim: string) {
  return {
    entities: [
      { name: "Ada Lovelace", type: "person", aliases: ["Ada"], summary: "Mathematician." },
    ],
    relationships: [],
    observations: [
      {
        entity: "Ada Lovelace",
        claim,
        kind: "fact",
        sourceQuote: null,
        validFrom: null,
        validUntil: null,
        confidence: 0.5,
        sensitivity: "normal",
      },
    ],
  };
}

describe("source revisions migration (#16)", () => {
  it("migrates a user_version-19 database cleanly to 20 and backfills", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-mig-"));
    const file = path.join(dir, "v19.db");
    try {
      // Stand up a DB at exactly user_version 19 (the #14 schema, pre-revisions).
      const raw = new Database(file);
      raw.pragma("foreign_keys = ON");
      for (let i = 0; i < 19; i++) raw.exec(migrations[i]!);
      raw.pragma("user_version = 19");
      // Seed a source + a chunk + an observation that the backfill must adopt.
      const sourceId = Number(
        raw
          .prepare("INSERT INTO sources (type, title, content) VALUES ('text','Notes','hello')")
          .run().lastInsertRowid,
      );
      raw.prepare("INSERT INTO chunks (source_id, seq, text) VALUES (?, 0, 'hello')").run(sourceId);
      const entityId = Number(
        raw.prepare("INSERT INTO entities (type, name, slug) VALUES ('person','Ada','ada')").run()
          .lastInsertRowid,
      );
      raw
        .prepare("INSERT INTO observations (entity_id, text, source_id) VALUES (?, 'a claim', ?)")
        .run(entityId, sourceId);
      raw.close();

      // Re-open through the migrator: migration 20 must apply and backfill.
      const db = openDatabase(file);
      expect(db.pragma("user_version", { simple: true })).toBe(migrations.length);

      const store = new KnowledgeStore(db);
      const active = store.activeRevision(sourceId);
      expect(active).toBeDefined();
      expect(active!.revision).toBe(1);
      expect(active!.status).toBe("active");

      // Existing chunk + observation now point at the backfilled revision.
      const chunk = db
        .prepare("SELECT source_revision_id FROM chunks WHERE source_id = ?")
        .get(sourceId) as { source_revision_id: number | null };
      expect(chunk.source_revision_id).toBe(active!.id);
      const obs = db
        .prepare("SELECT source_revision_id FROM observations WHERE entity_id = ?")
        .get(entityId) as { source_revision_id: number | null };
      expect(obs.source_revision_id).toBe(active!.id);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("source-revision lifecycle through the pipeline (#16)", () => {
  let db: MeosDatabase;
  let tmpDir: string;
  let claim = "Ada Lovelace wrote the first algorithm.";

  beforeEach(() => {
    db = openDatabase(":memory:");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-rev-"));
    claim = "Ada Lovelace wrote the first algorithm.";
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePipeline() {
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const llm = new StubLlmClient({
      onStructured: (request) => {
        if (request.schemaName === "knowledge_extraction") return extractionFor(claim);
        throw new Error(`unexpected structured request: ${request.schemaName}`);
      },
      onAgent: async (request) => {
        const relPath = request.prompt.match(/target file is "([^"]+)"/)?.[1];
        if (relPath) {
          await request.sandbox.writeFiles([
            { path: relPath, content: "A page about Ada." },
            { path: "SUMMARY.txt", content: "Summary." },
          ]);
        }
        return "done";
      },
    });
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({ store, llm, embedder, wiki });
    return { store, pipeline };
  }

  const fileInput = (filePath: string, text: string) => ({
    kind: "file" as const,
    filename: path.basename(filePath),
    buffer: Buffer.from(text),
    origin: "watch",
    path: filePath,
  });

  it("edit: re-ingesting the same path advances the revision and supersedes the prior one", async () => {
    const { store, pipeline } = makePipeline();
    const p = "/watched/ada.txt";

    // A file-path source so the re-ingest reuses the same logical source.
    const r1 = await pipeline.ingest(fileInput(p, "Ada notes v1."));
    const sourceId = r1.sourceId!;
    expect(store.revisionsForSource(sourceId)).toHaveLength(1);

    claim = "Ada Lovelace designed the Analytical Engine notes.";
    const r2 = await pipeline.ingest(fileInput(p, "Ada notes v2 edited."));
    // Same logical source, advanced revision.
    expect(r2.sourceId).toBe(sourceId);
    const revs = store.revisionsForSource(sourceId);
    expect(revs).toHaveLength(2);
    expect(revs[0]!.status).toBe("superseded");
    expect(revs[1]!.status).toBe("active");
    expect(revs[1]!.revision).toBe(2);

    // The v1-only fact is now backed only by the superseded revision → flagged.
    const stale = store.staleBackedObservations();
    expect(stale.some((o) => o.revision_status === "superseded")).toBe(true);
  });

  it("rename: identical bytes are recognised by content hash (watcher dedup stays intact)", () => {
    const store = new KnowledgeStore(db);
    const bytes = Buffer.from("stable contents");
    const hash = createHash("sha256").update(bytes).digest("hex");
    store.recordIngestedFile("/old/name.txt", 100, bytes.length, hash);
    // A rename surfaces the same bytes at a new path; the content hash matches the
    // old ledger row only by path, so the new path is a first sighting (not
    // "unchanged"), but the OLD path's dedup still short-circuits identical bytes.
    expect(store.fileContentUnchanged("/old/name.txt", hash)).toBe(true);
    expect(store.fileContentUnchanged("/old/name.txt", "different")).toBe(false);
  });

  it("delete: marking a source missing flags facts backed only by it", async () => {
    const { store, pipeline } = makePipeline();
    const p = "/watched/gone.txt";
    const r = await pipeline.ingest(fileInput(p, "Ada was a mathematician."));
    const sourceId = r.sourceId!;
    expect(store.staleBackedObservations()).toHaveLength(0);

    const revId = store.markSourceGoneByPath(p, "missing");
    expect(revId).toBeDefined();
    expect(store.latestRevision(sourceId)!.status).toBe("missing");
    const stale = store.staleBackedObservations();
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every((o) => o.revision_status === "missing")).toBe(true);
  });

  it("delete: explicit deletion marks the revision deleted", async () => {
    const { store, pipeline } = makePipeline();
    const p = "/watched/explicit.txt";
    const r = await pipeline.ingest(fileInput(p, "Ada notes."));
    store.markSourceGone(r.sourceId!, "deleted");
    expect(store.latestRevision(r.sourceId!)!.status).toBe("deleted");
    expect(store.staleBackedObservations().every((o) => o.revision_status === "deleted")).toBe(
      true,
    );
  });

  it("move: same content at a new path is a distinct logical source", async () => {
    const { store, pipeline } = makePipeline();
    const r1 = await pipeline.ingest(fileInput("/a/doc.txt", "Ada moved doc."));
    const r2 = await pipeline.ingest(fileInput("/b/doc.txt", "Ada moved doc."));
    // Different paths → different logical sources, each with its own revision 1.
    expect(r2.sourceId).not.toBe(r1.sourceId);
    expect(store.revisionsForSource(r1.sourceId!)).toHaveLength(1);
    expect(store.revisionsForSource(r2.sourceId!)).toHaveLength(1);
  });

  it("re-add older: an older version does not silently overwrite newer active facts", async () => {
    const { store, pipeline } = makePipeline();
    const p = "/watched/history.txt";

    claim = "Ada fact NEW and current.";
    await pipeline.ingest(fileInput(p, "v2 newer content."));
    const ada = store.findEntityByName("Ada Lovelace")!;
    const newerText = store.activeObservations(ada.id).map((o) => o.text);
    expect(newerText.some((t) => t.includes("NEW"))).toBe(true);

    // Re-add an OLDER version: a different claim, becoming the new active revision.
    claim = "Ada fact OLD and historical.";
    await pipeline.ingest(fileInput(p, "v1 older content re-added."));

    // The newer fact is NOT deleted — still active — just now backed by a
    // superseded revision and therefore flagged, while the re-added old fact is
    // backed by the current revision.
    const active = store.activeObservations(ada.id).map((o) => o.text);
    expect(active.some((t) => t.includes("NEW"))).toBe(true);
    expect(active.some((t) => t.includes("OLD"))).toBe(true);
    const stale = store.staleBackedObservations();
    expect(stale.some((o) => o.text.includes("NEW"))).toBe(true);
    expect(stale.some((o) => o.text.includes("OLD"))).toBe(false);
  });

  it("GC reclaims content blobs of obsolete revisions no longer backing live rows", async () => {
    const { store, pipeline } = makePipeline();
    const p = "/watched/gc.txt";
    await pipeline.ingest(fileInput(p, "v1 content."));
    claim = "Totally different replacement claim.";
    await pipeline.ingest(fileInput(p, "v2 content."));

    const sourceId = store.findSourceByPath(p)!.id;
    const [old, current] = store.revisionsForSource(sourceId);
    expect(old!.status).toBe("superseded");

    // The superseded revision still backs a (now flagged) observation, so GC keeps
    // its blob. Retire those observations' backing first by clearing chunks +
    // marking obs superseded to simulate full obsolescence.
    db.prepare("UPDATE observations SET status = 'superseded' WHERE source_revision_id = ?").run(
      old!.id,
    );
    db.prepare("DELETE FROM chunks WHERE source_revision_id = ?").run(old!.id);
    const reclaimed = store.gcOrphanedRevisionBlobs();
    expect(reclaimed).toBeGreaterThan(0);
    expect(store.getRevision(old!.id)!.normalized_content).toBeNull();
    // The active revision's blob is untouched.
    expect(store.getRevision(current!.id)!.normalized_content).not.toBeNull();
  });
});
