import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  IngestPriority,
  JobQueue,
  KnowledgeStore,
  openDatabase,
  type IngestionPipeline,
  type MeosDatabase,
} from "@meos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableIngest } from "../src/durable-ingest.js";

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
    const durable = new DurableIngest({ store, pipeline: recordingPipeline, queue, stagingDir });
    durable.pump();
    await queue.onIdle();

    // The executor recovered the title (from payload) + body (from staging)...
    expect(received).toEqual({ kind: "text", title: "Pasted note", text: "the recovered body" });
    // ...drove the job to completion...
    expect(store.getIngestJob(jobId)!.state).toBe("completed");
    // ...and discarded the now-unneeded staging bytes.
    expect(fs.existsSync(path.join(stagingDir, String(jobId)))).toBe(false);
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
});
