import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrations, openDatabase, type MeosDatabase } from "../src/db/database.js";
import { extractKnowledgeMapReduce, SINGLE_PASS_TOKEN_LIMIT } from "../src/extract/map-reduce.js";
import { reduceExtractions } from "../src/extract/reduce.js";
import type { Extraction } from "../src/extract/schema.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient, type StructuredRequest } from "../src/llm/index.js";

/** Pull the section/document text the stub was asked to extract. */
function requestText(request: StructuredRequest<unknown>): string {
  const msg = request.messages[0]!;
  return typeof msg.content === "string" ? msg.content : "";
}

/** A trivially-empty extraction the stub returns when no canned fact matches. */
const EMPTY: Extraction = { entities: [], relationships: [], observations: [] };

function makeStore(): { store: KnowledgeStore; db: MeosDatabase; revisionId: number } {
  const db = openDatabase(":memory:");
  const store = new KnowledgeStore(db);
  const sourceId = store.createSource({ type: "text", title: "Doc", content: "x" });
  const revisionId = store.createSourceRevision({ sourceId });
  return { store, db, revisionId };
}

describe("map-reduce extraction (#15)", () => {
  let db: MeosDatabase | undefined;
  afterEach(() => db?.close());

  it("small documents take the single pass, unchanged", async () => {
    const ctx = makeStore();
    db = ctx.db;
    const fact: Extraction = {
      entities: [{ name: "Ada", type: "person", aliases: [], summary: "A person." }],
      relationships: [],
      observations: [
        {
          entity: "Ada",
          claim: "Ada wrote the first algorithm.",
          kind: "fact",
          sourceQuote: "Ada wrote the first algorithm.",
          validFrom: null,
          validUntil: null,
          confidence: 0.6,
          sensitivity: "normal",
        },
      ],
    };
    const llm = new StubLlmClient({ onStructured: () => fact });

    const result = await extractKnowledgeMapReduce(
      llm,
      { title: "Doc", text: "Ada wrote the first algorithm." },
      { store: ctx.store, sourceRevisionId: ctx.revisionId, modelId: "m1" },
    );

    expect(result.strategy).toBe("single");
    // Exactly one LLM call — no regression in cost/latency for small docs.
    expect(llm.requests.length).toBe(1);
    expect(result.extraction.observations).toHaveLength(1);
  });

  it("long documents go map-reduce: all facts extracted, deduped, evidence preserved", async () => {
    const ctx = makeStore();
    db = ctx.db;

    // Three distinct facts, one per section. Each section is a heading + body so
    // chunkBlocks keeps them apart. The stub returns the fact whose marker the
    // section text contains; a repeated entity appears in two sections.
    const FACTS: Record<string, Extraction> = {
      ALPHA: {
        entities: [
          { name: "Ada", type: "person", aliases: ["A. Lovelace"], summary: "Mathematician." },
        ],
        relationships: [],
        observations: [
          {
            entity: "Ada",
            claim: "Ada wrote the first algorithm.",
            kind: "fact",
            sourceQuote: "Ada wrote the first algorithm in 1843.",
            validFrom: null,
            validUntil: null,
            confidence: 0.5,
            sensitivity: "normal",
          },
        ],
      },
      BETA: {
        entities: [{ name: "Babbage", type: "person", aliases: [], summary: "Engineer." }],
        relationships: [{ from: "Babbage", to: "Ada", label: "collaborates with" }],
        observations: [
          {
            entity: "Babbage",
            claim: "Babbage designed the Analytical Engine.",
            kind: "fact",
            sourceQuote: "Babbage designed the Analytical Engine.",
            validFrom: null,
            validUntil: null,
            confidence: 0.7,
            sensitivity: "normal",
          },
        ],
      },
      // GAMMA re-mentions Ada (alias) with a HIGHER-confidence variant of the
      // same claim — the reduce must keep the higher-confidence evidence.
      GAMMA: {
        entities: [
          {
            name: "A. Lovelace",
            type: "person",
            aliases: ["Ada"],
            summary: "Pioneer of computing.",
          },
        ],
        relationships: [],
        observations: [
          {
            entity: "A. Lovelace",
            claim: "Ada wrote the first algorithm.",
            kind: "fact",
            sourceQuote: "Lovelace authored the first algorithm.",
            validFrom: null,
            validUntil: null,
            confidence: 0.95,
            sensitivity: "normal",
          },
        ],
      },
    };

    const llm = new StubLlmClient({
      onStructured: (request) => {
        const text = requestText(request);
        for (const [marker, fact] of Object.entries(FACTS)) {
          if (text.includes(marker)) return fact;
        }
        return EMPTY;
      },
    });

    // Build a document large enough to clear the size gate, with each fact in its
    // own heading-delimited section. Padding makes the whole text exceed the
    // single-pass token limit so the map-reduce path is taken.
    const pad = "filler sentence. ".repeat(600);
    const text =
      `# Alpha\n\nALPHA Ada wrote the first algorithm in 1843. ${pad}\n\n` +
      `# Beta\n\nBETA Babbage designed the Analytical Engine. ${pad}\n\n` +
      `# Gamma\n\nGAMMA Lovelace authored the first algorithm. ${pad}`;
    expect(text.length / 4).toBeGreaterThan(SINGLE_PASS_TOKEN_LIMIT);

    const result = await extractKnowledgeMapReduce(
      llm,
      { title: "Computing pioneers", text },
      { store: ctx.store, sourceRevisionId: ctx.revisionId, modelId: "m1" },
    );

    expect(result.strategy).toBe("map-reduce");
    expect(result.llmCalls).toBeGreaterThanOrEqual(3);

    // Both distinct people survive, deduped by alias (Ada == A. Lovelace).
    const names = result.extraction.entities.map((e) => e.name).sort();
    expect(names).toEqual(["Ada", "Babbage"]);
    // Aliases unioned across sections.
    const ada = result.extraction.entities.find((e) => e.name === "Ada")!;
    expect(ada.aliases).toContain("A. Lovelace");

    // All three facts present, but the duplicated Ada claim is collapsed to one.
    const claims = result.extraction.observations.map((o) => o.claim).sort();
    expect(claims).toEqual([
      "Ada wrote the first algorithm.",
      "Babbage designed the Analytical Engine.",
    ]);

    // The surviving Ada observation kept the HIGHER-confidence evidence pointer.
    const adaObs = result.extraction.observations.find((o) => o.entity === "Ada")!;
    expect(adaObs.confidence).toBe(0.95);
    expect(adaObs.sourceQuote).toBe("Lovelace authored the first algorithm.");

    // Relationship endpoint rewritten onto the canonical entity name.
    expect(result.extraction.relationships).toContainEqual({
      from: "Babbage",
      to: "Ada",
      label: "collaborates with",
    });
  });

  it("re-extracting the same revision hits the cache (no second LLM call); a version change misses", async () => {
    const ctx = makeStore();
    db = ctx.db;
    let calls = 0;
    const fact: Extraction = {
      entities: [{ name: "Ada", type: "person", aliases: [], summary: "A person." }],
      relationships: [],
      observations: [],
    };
    const llm = new StubLlmClient({
      onStructured: () => {
        calls++;
        return fact;
      },
    });
    const source = { title: "Doc", text: "Ada wrote the first algorithm." };
    const opts = { store: ctx.store, sourceRevisionId: ctx.revisionId, modelId: "m1" };

    await extractKnowledgeMapReduce(llm, source, opts);
    expect(calls).toBe(1);

    // Same revision + same version tuple → cache hit, no new call.
    const second = await extractKnowledgeMapReduce(llm, source, opts);
    expect(calls).toBe(1);
    expect(second.cacheHits).toBe(1);
    expect(second.llmCalls).toBe(0);

    // Change a version component (the model id) → cache miss → recompute.
    await extractKnowledgeMapReduce(llm, source, { ...opts, modelId: "m2" });
    expect(calls).toBe(2);

    // Change the profile lens → another miss.
    await extractKnowledgeMapReduce(llm, source, { ...opts, profileContext: "I am a historian." });
    expect(calls).toBe(3);
  });
});

describe("reduceExtractions (#15) is pure and deterministic", () => {
  it("same partials always yield byte-identical output", () => {
    const partials: Extraction[] = [
      {
        entities: [{ name: "Ada", type: "person", aliases: ["A.L."], summary: "x" }],
        relationships: [],
        observations: [
          {
            entity: "Ada",
            claim: "c1",
            kind: "fact",
            sourceQuote: "q1",
            validFrom: null,
            validUntil: null,
            confidence: 0.4,
            sensitivity: "normal",
          },
        ],
      },
      {
        entities: [{ name: "A.L.", type: "person", aliases: ["Ada"], summary: "longer summary" }],
        relationships: [],
        observations: [
          {
            entity: "A.L.",
            claim: "c1",
            kind: "fact",
            sourceQuote: "q2",
            validFrom: null,
            validUntil: null,
            confidence: 0.9,
            sensitivity: "private",
          },
        ],
      },
    ];
    const a = JSON.stringify(reduceExtractions(partials));
    const b = JSON.stringify(reduceExtractions(partials));
    expect(a).toBe(b);

    const reduced = reduceExtractions(partials);
    expect(reduced.entities).toHaveLength(1);
    expect(reduced.entities[0]!.summary).toBe("longer summary"); // richest kept
    expect(reduced.observations).toHaveLength(1);
    // Higher-confidence claim wins, carrying its evidence + stronger sensitivity.
    expect(reduced.observations[0]!.confidence).toBe(0.9);
    expect(reduced.observations[0]!.sourceQuote).toBe("q2");
    expect(reduced.observations[0]!.sensitivity).toBe("private");
  });
});

describe("migration 22 (extraction cache)", () => {
  it("migrates a v21-shape DB cleanly, preserving data", () => {
    expect(migrations.length).toBe(35);

    const file = path.join(os.tmpdir(), `meos-mig22-${Date.now()}-${Math.random()}.db`);
    try {
      // Build a current-shape DB, seed a source + revision, then rewind to v21.
      const db = openDatabase(file);
      const store = new KnowledgeStore(db);
      const sourceId = store.createSource({ type: "file", title: "Legacy", content: "old text" });
      const revisionId = store.createSourceRevision({ sourceId });

      // Drop the migration-22/23/24 artifacts and reset user_version, simulating
      // a DB created before #15 shipped.
      db.exec(`DROP INDEX IF EXISTS idx_meeting_links_source;`);
      db.exec(`DROP TABLE IF EXISTS meeting_link_suggestions;`);
      db.exec(`DROP TABLE IF EXISTS meeting_notes;`);
      db.exec(`DROP TABLE IF EXISTS extraction_cache;`);
      db.exec(`ALTER TABLE connector_items DROP COLUMN source_revision_id;`);
      db.exec(`DROP INDEX IF EXISTS idx_ingest_jobs_claim;`);
      db.exec(`ALTER TABLE ingest_jobs DROP COLUMN priority;`);
      db.exec(`ALTER TABLE connector_sync_state DROP COLUMN config;`);
      db.exec(
        `ALTER TABLE connector_accounts DROP COLUMN auth_config; ALTER TABLE wiki_pages DROP COLUMN body_hash; ALTER TABLE wiki_pages DROP COLUMN authored_by; ALTER TABLE wiki_runs DROP COLUMN author;`,
      );
      db.pragma("user_version = 21");
      db.close();

      // Re-open through the real migrator: migration 22 must apply cleanly.
      const upgraded = openDatabase(file);
      expect(upgraded.pragma("user_version", { simple: true })).toBe(migrations.length);

      const upStore = new KnowledgeStore(upgraded);
      // Legacy revision survived...
      expect(upStore.getRevision(revisionId)?.source_id).toBe(sourceId);
      // ...and the new cache table works.
      const key = {
        sourceRevisionId: revisionId,
        contentHash: "h",
        schemaVersion: "s",
        promptVersion: "p",
        modelId: "m",
        profileVersion: "pv",
      };
      expect(upStore.getCachedExtraction(key)).toBeUndefined();
      upStore.putCachedExtraction(key, EMPTY, "single", 42);
      expect(upStore.getCachedExtraction(key)).toEqual(EMPTY);
      expect(upStore.extractionCacheForRevision(revisionId)[0]?.token_usage).toBe(42);
      upgraded.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.rmSync(file + suffix);
        } catch {
          /* ignore */
        }
      }
    }
  });
});
