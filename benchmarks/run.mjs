#!/usr/bin/env node
/**
 * Benchmark orchestrator. Runs the retrieval, ingestion, and performance suites
 * against the real (built) @meos/core and writes JSON + CSV results into
 * benchmarks/results/ (gitignored). Fully deterministic for the quality metrics:
 * the same inputs produce the same numbers on every run. Only the performance
 * timings vary by machine.
 *
 *   pnpm bench       full run (more performance iterations)
 *   pnpm bench:ci    CI-safe subset: no network, no real LLM, fewer iterations
 *
 * Both modes use HashEmbedder + StubLlmClient, so neither hits the network nor a
 * real model — the only difference is performance iteration count and a leaner
 * console summary.
 */
import { runIngestionBench } from "./ingestion.bench.mjs";
import { runPerformanceBench } from "./performance.bench.mjs";
import { runRetrievalBench } from "./retrieval.bench.mjs";
import { writeResults } from "./lib/report.mjs";

async function main() {
  const ci = process.argv.includes("--ci");
  const startedAt = new Date().toISOString();

  const [retrieval, ingestion, performance] = [
    await runRetrievalBench(),
    await runIngestionBench(),
    await runPerformanceBench({ ci }),
  ];

  const results = {
    meta: {
      generatedAt: startedAt,
      mode: ci ? "ci" : "full",
      node: process.version,
      deterministic: true,
      notes: "Quality metrics are deterministic; performance timings are machine-dependent.",
    },
    suites: { retrieval, ingestion, performance },
  };

  const name = ci ? "latest-ci" : "latest";
  const { jsonPath, csvPath } = writeResults(name, results);

  printSummary(results, ci);
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${csvPath}`);
}

function printSummary(results, ci) {
  const { retrieval, ingestion, performance } = results.suites;
  console.log(`\n=== meOS benchmarks (${ci ? "CI subset" : "full"}) ===\n`);
  console.log("Retrieval:");
  console.log(`  queries            ${retrieval.queries}`);
  console.log(`  hit@1 / hit@3      ${retrieval.hitRateAt1} / ${retrieval.hitRateAt3}`);
  console.log(`  MRR                ${retrieval.mrr}`);
  console.log(`  citation accuracy  ${retrieval.citationAccuracy}`);
  console.log(`  false-positive     ${retrieval.falsePositiveRate}`);
  console.log("\nIngestion:");
  console.log(`  documents          ${ingestion.documents}`);
  console.log(`  extraction acc.    ${ingestion.extractionAccuracy}`);
  console.log(`  entities / obs     ${ingestion.totalEntities} / ${ingestion.totalObservations}`);
  console.log(`  dedup reinforce    ${ingestion.dedupReinforcements}`);
  console.log(`  temporal claims    ${ingestion.temporalClaims}`);
  console.log(`  superseded         ${ingestion.supersededFacts}`);
  console.log(`  contradictions     ${ingestion.contradictionsDetected}`);
  console.log("\nPerformance:");
  console.log(`  embed texts/s      ${performance.embedding.textsPerSecond}`);
  console.log(`  retrieval ms (p50) ${performance.retrieval.p50Ms}`);
  console.log(`  retrieval q/s      ${performance.retrieval.queriesPerSecond}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
