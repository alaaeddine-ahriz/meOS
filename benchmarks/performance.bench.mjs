import { loadCore, seedRetrievalStore } from "./lib/harness.mjs";
import { mean, round } from "./lib/metrics.mjs";
import { loadFixture, time } from "./lib/report.mjs";

/**
 * Performance benchmark: timing and throughput for the deterministic hot paths
 * (embedding, hybrid retrieval). Numbers are wall-clock and machine-dependent —
 * the value is relative comparison across commits, not absolute SLAs. Iteration
 * count is fixed so throughput is reproducible in shape.
 */
export async function runPerformanceBench(options = {}) {
  const iterations = options.iterations ?? (options.ci ? 20 : 100);
  const core = await loadCore();
  const corpus = loadFixture("retrieval-corpus.json");
  const { store, embedder } = await seedRetrievalStore(core, corpus);
  const { buildContextPack } = core;

  // --- embedding throughput ---
  const sampleTexts = corpus.observations.map((o) => o.text);
  const embedSamples = [];
  for (let i = 0; i < iterations; i++) {
    const { ms } = await time(() => embedder.embed(sampleTexts));
    embedSamples.push(ms);
  }
  const embedMs = mean(embedSamples);
  const embedThroughput = embedMs > 0 ? (sampleTexts.length / embedMs) * 1000 : 0;

  // --- retrieval latency / throughput ---
  const queries = corpus.queries.map((q) => q.query);
  const retrievalSamples = [];
  for (let i = 0; i < iterations; i++) {
    const query = queries[i % queries.length];
    const { ms } = await time(() => buildContextPack(store, embedder, query));
    retrievalSamples.push(ms);
  }
  const retrievalMs = mean(retrievalSamples);
  const retrievalThroughput = retrievalMs > 0 ? 1000 / retrievalMs : 0;

  return {
    iterations,
    embedding: {
      textsPerBatch: sampleTexts.length,
      avgBatchMs: round(embedMs, 4),
      textsPerSecond: round(embedThroughput, 2),
    },
    retrieval: {
      avgLatencyMs: round(retrievalMs, 4),
      p50Ms: round(percentile(retrievalSamples, 0.5), 4),
      p95Ms: round(percentile(retrievalSamples, 0.95), 4),
      queriesPerSecond: round(retrievalThroughput, 2),
    },
  };
}

function percentile(samples, p) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
