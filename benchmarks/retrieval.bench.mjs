import { loadCore, seedRetrievalStore } from "./lib/harness.mjs";
import {
  citationPrecision,
  falsePositiveRate,
  hitAtK,
  mean,
  reciprocalRank,
  round,
} from "./lib/metrics.mjs";
import { loadFixture, time } from "./lib/report.mjs";

/**
 * Retrieval-quality benchmark. Seeds the deterministic corpus into the real
 * SQLite store and runs each labelled query through buildContextPack (the
 * production hybrid vector + FTS retrieval path). Reports top-k hit rate, MRR,
 * citation precision/accuracy, and false-positive rate, plus per-query latency.
 */
export async function runRetrievalBench() {
  const core = await loadCore();
  const corpus = loadFixture("retrieval-corpus.json");
  const { store, embedder, entityIds, sourceIds } = await seedRetrievalStore(core, corpus);
  const { buildContextPack } = core;

  const perQuery = [];
  for (const q of corpus.queries) {
    const relevantEntityIds = q.relevantEntities.map((ref) => entityIds.get(ref));
    const relevantSourceIds = q.relevantSources.map((ref) => sourceIds.get(ref));

    const { value: pack, ms } = await time(() => buildContextPack(store, embedder, q.query));

    // Ranked entity ids (graph-expansion order) and cited source ids (citation
    // set order) drive the ranking metrics.
    const rankedEntities = pack.matchedEntities.map((e) => e.id);
    const citedSources = pack.sources.map((s) => s.id);

    perQuery.push({
      id: q.id,
      latencyMs: round(ms, 3),
      hitAt1: hitAtK(rankedEntities, relevantEntityIds, 1),
      hitAt3: hitAtK(rankedEntities, relevantEntityIds, 3),
      mrr: round(reciprocalRank(rankedEntities, relevantEntityIds)),
      citationPrecision: round(citationPrecision(citedSources, relevantSourceIds)),
      falsePositiveRate: round(falsePositiveRate(citedSources, relevantSourceIds)),
    });
  }

  const aggregate = {
    queries: perQuery.length,
    hitRateAt1: round(mean(perQuery.map((q) => q.hitAt1))),
    hitRateAt3: round(mean(perQuery.map((q) => q.hitAt3))),
    mrr: round(mean(perQuery.map((q) => q.mrr))),
    citationAccuracy: round(mean(perQuery.map((q) => q.citationPrecision))),
    falsePositiveRate: round(mean(perQuery.map((q) => q.falsePositiveRate))),
    avgLatencyMs: round(mean(perQuery.map((q) => q.latencyMs)), 3),
  };

  store.constructor; // keep store referenced; db closes with process
  return { ...aggregate, perQuery };
}
