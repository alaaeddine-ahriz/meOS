import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { runConsolidation } from "../src/memory/consolidate.js";
import { detectContradictions } from "../src/memory/contradictions.js";
import { WikiWriter } from "../src/wiki/writer.js";

describe("memory maintenance", () => {
  let db: MeosDatabase;
  let store: KnowledgeStore;
  let tmpDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new KnowledgeStore(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-memory-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedEntityWithObservations() {
    const embedder = new HashEmbedder();
    const entity = store.createEntity({ type: "person", name: "Dana" });
    const [v1, v2] = await embedder.embed(["Dana lives in Paris.", "Dana moved to Berlin in May."]);
    const oldId = store.insertObservation({
      entityId: entity.id,
      text: "Dana lives in Paris.",
      embedding: v1!,
      confidence: 0.7,
    });
    const newId = store.insertObservation({
      entityId: entity.id,
      text: "Dana moved to Berlin in May.",
      embedding: v2!,
      confidence: 0.5,
    });
    return { entity, oldId, newId };
  }

  it("supersedes outdated facts when the judge says so", async () => {
    const { entity, oldId, newId } = await seedEntityWithObservations();
    const llm = new StubLlmClient({
      onStructured: () => ({
        conflicts: [
          { new_id: newId, existing_id: oldId, kind: "supersedes", note: "moved cities" },
        ],
      }),
    });

    const summary = await detectContradictions(store, llm, [newId]);

    expect(summary.superseded).toBe(1);
    const old = store.getObservation(oldId)!;
    expect(old.status).toBe("superseded");
    expect(old.superseded_by).toBe(newId);
    // superseded fact no longer feeds the wiki or chat context
    expect(store.activeObservations(entity.id).map((o) => o.id)).toEqual([newId]);
    expect(store.getEntity(entity.id)!.wiki_stale).toBe(1);
  });

  it("records genuine contradictions for review", async () => {
    const { oldId, newId } = await seedEntityWithObservations();
    const llm = new StubLlmClient({
      onStructured: () => ({
        conflicts: [
          { new_id: newId, existing_id: oldId, kind: "contradicts", note: "conflicting cities" },
        ],
      }),
    });

    const summary = await detectContradictions(store, llm, [newId]);

    expect(summary.contradictions).toBe(1);
    const open = store.unresolvedContradictions();
    expect(open).toHaveLength(1);
    expect(open[0]!.entity_name).toBe("Dana");
  });

  it("decays unconfirmed knowledge and promotes corroborated observations", async () => {
    const { oldId, newId } = await seedEntityWithObservations();
    // backdate one observation far beyond the decay window
    db.prepare(
      "UPDATE observations SET last_confirmed_at = datetime('now', '-90 days') WHERE id = ?",
    ).run(oldId);
    // corroborate the other past the promotion threshold
    db.prepare("UPDATE observations SET confidence = 0.8 WHERE id = ?").run(newId);

    expect(store.decayStaleConfidence(30, 0.05)).toBe(1);
    expect(store.getObservation(oldId)!.confidence).toBeCloseTo(0.65, 5);

    expect(store.promoteFacts(0.75)).toBe(1);
    expect(store.getObservation(newId)!.tier).toBe("fact");
  });

  it("runs consolidation end-to-end and writes the digest", async () => {
    const { entity, newId } = await seedEntityWithObservations();
    // Dana needs ≥3 active, non-private facts to clear the wiki page-worthiness
    // bar (gate B) so the stale page is actually regenerated below.
    store.insertObservation({
      entityId: entity.id,
      text: "Dana works as a designer.",
      confidence: 0.7,
    });
    db.prepare("UPDATE observations SET confidence = 0.9 WHERE id = ?").run(newId);

    const llm = new StubLlmClient({
      onComplete: () => "## Your morning digest\n\nYou captured notes about [[Dana]].",
      onStructured: () => ({ summary: "A person.", body: "About [[Dana]]." }),
    });
    const wiki = new WikiWriter(store, llm, path.join(tmpDir, "wiki"));

    const report = await runConsolidation({
      store,
      llm,
      wiki,
      digestDir: path.join(tmpDir, "digests"),
    });

    expect(report.promoted).toBe(1);
    expect(report.staleRegenerated).toBe(1); // the seeded entity was stale
    expect(report.orphanCount).toBe(1); // Dana has no relationships yet

    const digest = store.latestDigest()!;
    expect(digest.content).toContain("morning digest");
    // portable artifact written to disk alongside the database
    const onDisk = fs.readFileSync(
      path.join(tmpDir, "digests", `${report.digestDate}.md`),
      "utf-8",
    );
    expect(onDisk).toBe(digest.content);
  });

  it("self-heals wiki pages whose [[links]] point at unknown entities", async () => {
    const dana = store.createEntity({ type: "person", name: "Dana" });
    store.clearWikiStale(dana.id); // start from a clean, non-stale page
    // a persisted page linking an entity that does not exist
    store.upsertWikiPage(dana.id, "Dana collaborates with [[Ghost Person]].");
    expect(store.staleEntities()).toHaveLength(0);

    const llm = new StubLlmClient({ onComplete: () => "Digest." });
    const wiki = new WikiWriter(store, llm, path.join(tmpDir, "wiki"));

    const report = await runConsolidation({
      store,
      llm,
      wiki,
      digestDir: path.join(tmpDir, "digests"),
    });

    expect(report.brokenLinksRepaired).toBe(1); // the broken page was flagged for repair
  });
});
