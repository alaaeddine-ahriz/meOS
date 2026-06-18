import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  IngestPriority,
  JobQueue,
  KnowledgeStore,
  openDatabase,
  Semaphore,
  type IngestionPipeline,
  type MeosDatabase,
} from "@meos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableIngest } from "../src/durable-ingest.js";

/** A generous descriptor budget — these tests never approach it; it just
 * satisfies the dependency so the real read paths can run. */
const fsLimit = new Semaphore(64);

/**
 * Backpressure + priority of the durable ingest orchestration (#18). We drive
 * the real {@link DurableIngest} against an in-memory store and a stub pipeline
 * whose `ingest` blocks until we release it, so we can observe — deterministically
 * — how many jobs a single pump admits onto the executor (the per-tick batch cap)
 * and that high-priority work is admitted first.
 */
describe("DurableIngest backpressure + priority (#18)", () => {
  let db: MeosDatabase;
  let stagingDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-staging-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(stagingDir, { recursive: true, force: true });
  });

  /** A pipeline whose ingest blocks forever, so admitted jobs stay `processing`. */
  function blockingPipeline(): IngestionPipeline {
    return {
      ingest: () => new Promise(() => {}),
      retryExtractionForSource: () => new Promise(() => {}),
    } as unknown as IngestionPipeline;
  }

  it("admits at most maxBatchesPerPump jobs per pump (per-tick cap)", () => {
    const store = new KnowledgeStore(db);
    // Enqueue more jobs than the cap; none have a live buffer, and all carry a
    // path so execute() would read from disk — but the blocking pipeline never
    // gets there because ingest() is reached only for live inputs. To exercise
    // the claim/admission cap deterministically we point each at a source so
    // execute() takes the retryExtractionForSource branch (which also blocks).
    const sourceId = store.createSource({ type: "file", title: "Doc", content: "x" });
    for (let i = 0; i < 5; i++) {
      store.createIngestJob({ kind: "file", sourceId });
    }

    const queue = new JobQueue(10);
    const durable = new DurableIngest({
      store,
      pipeline: blockingPipeline(),
      queue,
      fsLimit,
      stagingDir,
      maxBatchesPerPump: 2,
    });
    expect(durable.batchCap).toBe(2);

    durable.pump();
    // Exactly the cap was claimed → flipped to processing; the rest stay pending.
    const depths = store.ingestQueueMetrics().find((q) => q.queue === "extraction")!;
    expect(depths.processing).toBe(2);
    expect(depths.pending).toBe(3);
  });

  it("reconstructs a job's input from spilled staging bytes (cross-process)", async () => {
    const store = new KnowledgeStore(db);
    // Simulate the split: a job + its spilled bytes were produced by ANOTHER
    // process, so this executor never held the live buffer. The worker must
    // reconstruct the input from the staging file alone.
    const jobId = store.createIngestJob({
      kind: "text",
      payload: { kind: "text", title: "Pasted note" },
    });
    fs.writeFileSync(path.join(stagingDir, String(jobId)), "the recovered body", "utf8");

    let received: { kind: string; title?: string; text?: string } | null = null;
    const recordingPipeline = {
      ingest: async (input: { kind: string; title?: string; text?: string }) => {
        received = input;
        return { status: "done" as const };
      },
      retryExtractionForSource: () => new Promise(() => {}),
    } as unknown as IngestionPipeline;

    const queue = new JobQueue(1);
    const durable = new DurableIngest({
      store,
      pipeline: recordingPipeline,
      queue,
      fsLimit,
      stagingDir,
    });
    durable.pump();
    await queue.onIdle();

    // The executor recovered the title (from payload) + body (from staging)...
    expect(received).toEqual({ kind: "text", title: "Pasted note", text: "the recovered body" });
    // ...drove the job to completion...
    expect(store.getIngestJob(jobId)!.state).toBe("completed");
    // ...and discarded the now-unneeded staging bytes.
    expect(fs.existsSync(path.join(stagingDir, String(jobId)))).toBe(false);
  });

  it("records the real failing stage + error on an extraction failure (not a wrapper)", async () => {
    const store = new KnowledgeStore(db);
    // maxAttempts: 1 → the single failure dead-letters immediately (no re-pump),
    // mirroring a job that "gave up after retries".
    const jobId = store.createIngestJob({
      kind: "text",
      payload: { kind: "text", title: "Pasted note" },
      maxAttempts: 1,
    });
    fs.writeFileSync(path.join(stagingDir, String(jobId)), "body", "utf8");

    // Extraction fails after the source is searchable: the pipeline reports the
    // real stage + underlying error in the outcome.
    const extractionFailingPipeline = {
      ingest: async () => ({
        inboxItemId: 1,
        status: "indexed" as const,
        failedStage: "extraction" as const,
        error: "LLM extraction outage",
      }),
      retryExtractionForSource: () => new Promise(() => {}),
    } as unknown as IngestionPipeline;

    const queue = new JobQueue(1);
    const durable = new DurableIngest({
      store,
      pipeline: extractionFailingPipeline,
      queue,
      fsLimit,
      stagingDir,
    });
    durable.pump();
    await queue.onIdle();

    const job = store.getIngestJob(jobId)!;
    expect(job.state).toBe("dead-letter");
    // The job carries the stage that actually broke and the real error log —
    // what the Health view shows — not the generic "semantic extraction failed".
    expect(job.stage).toBe("extraction");
    expect(job.last_error).toBe("LLM extraction outage");
    expect(job.last_error).not.toContain("semantic extraction failed");
  });

  it("admits the highest-priority pending job first", () => {
    const store = new KnowledgeStore(db);
    const sourceId = store.createSource({ type: "file", title: "Doc", content: "x" });
    // A low-priority bulk job is enqueued before a high-priority user job.
    store.createIngestJob({ kind: "file", sourceId, priority: IngestPriority.NIGHTLY });
    const userJob = store.createIngestJob({
      kind: "file",
      sourceId,
      priority: IngestPriority.USER,
    });

    const queue = new JobQueue(10);
    const durable = new DurableIngest({
      store,
      pipeline: blockingPipeline(),
      queue,
      fsLimit,
      stagingDir,
      maxBatchesPerPump: 1,
    });

    durable.pump();
    // With a cap of 1, the user job was admitted; the bulk job is still pending.
    expect(store.getIngestJob(userJob)!.state).toBe("processing");
    const metrics = store.ingestQueueMetrics().find((q) => q.queue === "extraction")!;
    expect(metrics.processing).toBe(1);
    expect(metrics.pending).toBe(1);

    durable.stop();
  });

  it("admits nothing while paused, then drains on resume (#98)", () => {
    const store = new KnowledgeStore(db);
    const sourceId = store.createSource({ type: "file", title: "Doc", content: "x" });
    store.createIngestJob({ kind: "file", sourceId });
    store.setIngestPaused(true);

    const queue = new JobQueue(10);
    const durable = new DurableIngest({
      store,
      pipeline: blockingPipeline(),
      queue,
      fsLimit,
      stagingDir,
    });

    durable.pump();
    // Paused: the job stays pending — nothing is admitted onto the executor.
    let depth = store.ingestQueueMetrics().find((q) => q.queue === "extraction")!;
    expect(depth.processing).toBe(0);
    expect(depth.pending).toBe(1);

    durable.resume(); // clears the flag + wakes the executor (synchronous pump)
    depth = store.ingestQueueMetrics().find((q) => q.queue === "extraction")!;
    expect(depth.processing).toBe(1);
    durable.stop();
  });

  it("cancel removes a job and drops its staging bytes (#98)", () => {
    const store = new KnowledgeStore(db);
    const jobId = store.createIngestJob({ kind: "text", payload: { kind: "text", title: "x" } });
    const staged = path.join(stagingDir, String(jobId));
    fs.writeFileSync(staged, "bytes");

    const durable = new DurableIngest({
      store,
      pipeline: blockingPipeline(),
      queue: new JobQueue(1),
      fsLimit,
      stagingDir,
    });
    expect(durable.cancel(jobId)).toBe(true);
    expect(store.getIngestJob(jobId)).toBeUndefined();
    expect(fs.existsSync(staged)).toBe(false);
  });
});
