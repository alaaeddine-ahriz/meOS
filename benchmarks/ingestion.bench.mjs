import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCore, makeIngestionStub } from "./lib/harness.mjs";
import { mean, round } from "./lib/metrics.mjs";
import { loadFixture, time } from "./lib/report.mjs";

/**
 * Ingestion-quality benchmark. Runs each fixture document through the real
 * IngestionPipeline (parse -> chunk -> embed -> extract -> merge -> wiki) with a
 * StubLlmClient + HashEmbedder, then runs the real detectContradictions over the
 * new observations. Measures extracted entities/relationships/observations,
 * temporal claims, dedup (reinforcement), and supersession/contradiction
 * detection against the fixture's ground truth, plus stage timing.
 */
export async function runIngestionBench() {
  const core = await loadCore();
  const {
    openDatabase,
    KnowledgeStore,
    HashEmbedder,
    IngestionPipeline,
    WikiWriter,
    detectContradictions,
  } = core;
  const corpus = loadFixture("ingestion-corpus.json");

  const db = openDatabase(":memory:");
  const store = new KnowledgeStore(db);
  const embedder = new HashEmbedder();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-bench-"));

  let currentDoc = null;
  // The pipeline's ingest() returns only an IngestOutcome (status/ids), not the
  // MergeResult. Capture it through the postMerge seam — the same hook the
  // server uses to run contradiction detection.
  let lastMerge = null;
  const llm = makeIngestionStub(core, () => currentDoc);
  const wiki = new WikiWriter(store, llm, tmpDir);
  const pipeline = new IngestionPipeline({
    store,
    llm,
    embedder,
    wiki,
    postMerge: ({ merge }) => {
      lastMerge = merge;
    },
  });

  const perDoc = [];
  try {
    for (const doc of corpus.documents) {
      currentDoc = doc;
      lastMerge = null;
      const entitiesBefore = store.listEntities().length;

      const { value: result, ms } = await time(() =>
        pipeline.ingest({ kind: "text", title: doc.title, text: doc.text }),
      );

      const merge = lastMerge;
      const newObservationIds = merge?.newObservationIds ?? [];

      // Run the real contradiction/supersession detector over the new facts —
      // the same call the server wires through onMemoryWrite.
      const { value: contradiction, ms: contradictionMs } = await time(() =>
        detectContradictions(store, llm, newObservationIds),
      );

      const entitiesAfter = store.listEntities().length;
      const measured = {
        newEntities: entitiesAfter - entitiesBefore,
        newObservations: newObservationIds.length,
        reinforcedObservations: merge?.reinforcedObservationIds.length ?? 0,
        relationships: doc.extraction.relationships.length,
        temporalClaims: countTemporal(doc.extraction.observations),
        superseded: contradiction.superseded,
        contradictions: contradiction.contradictions,
      };

      // Accuracy: fraction of the document's asserted expectations that matched.
      const expected = doc.expected;
      let checks = 0;
      let correct = 0;
      for (const key of Object.keys(expected)) {
        checks++;
        if (measured[key] === expected[key]) correct++;
      }

      perDoc.push({
        id: doc.id,
        status: result.status,
        latencyMs: round(ms, 3),
        contradictionMs: round(contradictionMs, 3),
        accuracy: round(checks === 0 ? 1 : correct / checks),
        measured,
        expected,
      });
    }
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const totals = perDoc.reduce(
    (acc, d) => {
      acc.entities += d.measured.newEntities;
      acc.observations += d.measured.newObservations;
      acc.reinforced += d.measured.reinforcedObservations;
      acc.relationships += d.measured.relationships;
      acc.temporalClaims += d.measured.temporalClaims;
      acc.superseded += d.measured.superseded;
      acc.contradictions += d.measured.contradictions;
      return acc;
    },
    {
      entities: 0,
      observations: 0,
      reinforced: 0,
      relationships: 0,
      temporalClaims: 0,
      superseded: 0,
      contradictions: 0,
    },
  );

  const aggregate = {
    documents: perDoc.length,
    extractionAccuracy: round(mean(perDoc.map((d) => d.accuracy))),
    totalEntities: totals.entities,
    totalObservations: totals.observations,
    dedupReinforcements: totals.reinforced,
    totalRelationships: totals.relationships,
    temporalClaims: totals.temporalClaims,
    supersededFacts: totals.superseded,
    contradictionsDetected: totals.contradictions,
    avgLatencyMs: round(mean(perDoc.map((d) => d.latencyMs)), 3),
  };

  return { ...aggregate, perDoc };
}

function countTemporal(observations) {
  return observations.filter((o) => o.validFrom != null || o.validUntil != null).length;
}
