# meOS benchmarks

A deterministic benchmark suite for personal-knowledge quality: **retrieval**,
**ingestion**, and **performance**. It exercises the real `@meos/core` pipeline
(SQLite vector + FTS hybrid retrieval, the ingestion pipeline, contradiction
detection) against small committed fixtures, so the numbers are a repeatable
baseline you can compare across commits before touching retrieval, chunking,
embedding, or memory logic.

Everything runs offline: `HashEmbedder` (deterministic token-hash vectors) +
`StubLlmClient` (canned, deterministic extractions and judgements). **No network,
no real LLM calls.** Same inputs → same metric numbers on every run (only the
performance timings vary by machine).

## Running

```sh
pnpm bench       # full run, writes JSON + CSV to benchmarks/results/
pnpm bench:ci    # CI-safe subset (fewer perf iterations), same deterministic metrics
```

Both scripts build `@meos/core` first (the runners import the built `dist/`).
Results land in `benchmarks/results/` (gitignored) as `latest.json` / `latest.csv`
(or `latest-ci.*`).

> The CI subset is runnable today but is intentionally **not** wired into the
> required CI workflow here — that is issue #21's job.

## What it measures

### Retrieval (`retrieval.bench.mjs`)

Seeds a labelled corpus (entities, curated observations, wiki pages, raw notes /
meeting notes / contact / architecture sources) into an in-memory store, then runs
each query through the production `buildContextPack` hybrid path:

- **top-k hit rate** (hit@1, hit@3) over matched entities
- **MRR** (mean reciprocal rank)
- **citation accuracy** (precision of the cited source set)
- **false-positive rate** among cited sources
- per-query and average **latency**

### Ingestion (`ingestion.bench.mjs`)

Runs each fixture document through the real `IngestionPipeline`
(parse → chunk → embed → extract → merge → wiki) and the real
`detectContradictions`, comparing against ground-truth `expected` counts:

- **entities / relationships / observations** extracted
- **temporal claims** (`validFrom` / `validUntil`)
- **dedup** (near-duplicate observations reinforced, not duplicated)
- **supersession** (a temporal update retires the prior fact)
- **contradiction detection** (genuine conflicts flagged for review)
- extraction **accuracy** vs. the fixture's ground truth, and stage **timing**

### Performance (`performance.bench.mjs`)

Wall-clock timing / throughput for the deterministic hot paths (embedding,
hybrid retrieval): batch ms, texts/s, retrieval p50/p95, queries/s. These are
machine-dependent — useful for relative comparison, not absolute SLAs.

## Layout

```
benchmarks/
  run.mjs                 # orchestrator (pnpm bench / bench:ci)
  retrieval.bench.mjs
  ingestion.bench.mjs
  performance.bench.mjs
  lib/
    harness.mjs           # loads built @meos/core, seeds stores, builds stubs
    metrics.mjs           # pure metric helpers (hit@k, MRR, precision, FPR)
    report.mjs            # JSON + CSV writers, timing, fixture loader
  fixtures/               # small, committed, deterministic corpora
    retrieval-corpus.json
    ingestion-corpus.json
  results/                # gitignored output (JSON + CSV)
```

## Adding cases

Append to the JSON fixtures — no code change needed. Retrieval queries reference
their relevant entities/sources by stable `ref` keys; ingestion documents carry a
canned `extraction`, an optional `judgement` (for supersession/contradiction), and
the `expected` ground-truth counts.
