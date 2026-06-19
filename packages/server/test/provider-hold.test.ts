import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JobQueue,
  KnowledgeStore,
  LlmError,
  openDatabase,
  Semaphore,
  type IngestionPipeline,
  type MeosDatabase,
} from "@meos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableIngest } from "../src/durable-ingest.js";

const fsLimit = new Semaphore(64);

/**
 * The provider circuit-breaker (#circuit). When the intelligence provider itself
 * is down — out of credits, a rejected key, an unknown model — no per-file retry
 * can fix it, so churning the whole backlog just reproduces the identical error N
 * times and dead-letters everything. Instead the executor must stop after the
 * FIRST fatal failure: hold the batch, leave the rest untouched, and requeue the
 * triggering job without spending a retry so it resumes intact once fixed.
 */
describe("DurableIngest provider circuit-breaker (#circuit)", () => {
  let db: MeosDatabase;
  let stagingDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-hold-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(stagingDir, { recursive: true, force: true });
  });

  /** A pipeline whose extraction-retry always fails as if the provider is out of
   * credits, counting how many documents it was actually asked to process. */
  function outOfCreditsPipeline(counter: { calls: number }): IngestionPipeline {
    return {
      ingest: () => new Promise(() => {}),
      retryExtractionForSource: async () => {
        counter.calls++;
        throw new LlmError(
          "Your OpenAI account is out of credits or has hit its quota.",
          "credits",
        );
      },
    } as unknown as IngestionPipeline;
  }

  it("stops after the first fatal failure instead of churning every file", async () => {
    const store = new KnowledgeStore(db);
    const counter = { calls: 0 };
    // Five queued documents, all pointing at a source so execute() takes the
    // extraction-retry branch (which fails with a provider-fatal error).
    const sourceId = store.createSource({ type: "file", title: "Doc", content: "x" });
    const jobIds = Array.from({ length: 5 }, () =>
      store.createIngestJob({ kind: "file", sourceId }),
    );

    const queue = new JobQueue(1);
    const durable = new DurableIngest({
      store,
      pipeline: outOfCreditsPipeline(counter),
      queue,
      fsLimit,
      stagingDir,
      // One admission per pump: if the breaker works, only the first file is ever
      // attempted; the gate then blocks every subsequent admission.
      maxBatchesPerPump: 1,
    });

    durable.pump();
    await queue.onIdle();

    // Only ONE document was processed — the breaker stopped the batch.
    expect(counter.calls).toBe(1);

    // The hold is engaged, classified, with the provider's own friendly reason.
    const hold = store.getIngestHold();
    expect(hold).not.toBeNull();
    expect(hold!.kind).toBe("credits");
    expect(hold!.reason).toContain("out of credits");

    // Nothing dead-lettered; every job is back to pending with its FULL retry
    // budget (the provider-down attempt didn't count against it).
    const depth = store.ingestQueueMetrics().find((q) => q.queue === "extraction")!;
    expect(depth.processing).toBe(0);
    expect(depth.pending).toBe(5);
    expect(depth.deadLetter).toBe(0);
    for (const id of jobIds) {
      const job = store.getIngestJob(id)!;
      expect(job.state).toBe("pending");
      expect(job.attempts).toBe(0);
    }

    // A further pump while held admits nothing — the bleeding has stopped.
    durable.pump();
    await queue.onIdle();
    expect(counter.calls).toBe(1);
    expect(store.ingestQueueMetrics().find((q) => q.queue === "extraction")!.processing).toBe(0);
  });

  it("resumes the held backlog once the provider is fixed", async () => {
    const store = new KnowledgeStore(db);
    const counter = { calls: 0 };
    const sourceId = store.createSource({ type: "file", title: "Doc", content: "x" });
    store.createIngestJob({ kind: "file", sourceId });

    let healthy = false;
    const queue = new JobQueue(1);
    const durable = new DurableIngest({
      store,
      pipeline: {
        ingest: () => new Promise(() => {}),
        retryExtractionForSource: async () => {
          counter.calls++;
          if (!healthy) throw new LlmError("rejected your API key (401)", "auth");
          return { affectedEntityIds: [], newObservationIds: [] } as never;
        },
      } as unknown as IngestionPipeline,
      queue,
      fsLimit,
      stagingDir,
      maxBatchesPerPump: 1,
    });

    durable.pump();
    await queue.onIdle();
    expect(store.getIngestHold()).not.toBeNull();

    // Provider fixed (e.g. the user pasted a working key): a Settings swap clears
    // the hold and drains the backlog on the now-healthy provider.
    healthy = true;
    durable.clearProviderHold();
    await queue.onIdle();

    expect(store.getIngestHold()).toBeNull();
    expect(store.ingestQueueMetrics().find((q) => q.queue === "extraction")!.completed).toBe(1);
  });

  it("does NOT hold for an ordinary per-document failure", async () => {
    const store = new KnowledgeStore(db);
    const sourceId = store.createSource({ type: "file", title: "Doc", content: "x" });
    const jobId = store.createIngestJob({ kind: "file", sourceId, maxAttempts: 1 });

    const queue = new JobQueue(1);
    const durable = new DurableIngest({
      store,
      pipeline: {
        ingest: () => new Promise(() => {}),
        // A document-specific failure (not a provider outage) — must NOT trip the
        // breaker; it should retry/dead-letter this one file as usual.
        retryExtractionForSource: async () => {
          throw new Error("this PDF is corrupt");
        },
      } as unknown as IngestionPipeline,
      queue,
      fsLimit,
      stagingDir,
    });

    durable.pump();
    await queue.onIdle();

    expect(store.getIngestHold()).toBeNull();
    // maxAttempts 1 → the one bad file dead-letters; the batch is not held.
    expect(store.getIngestJob(jobId)!.state).toBe("dead-letter");
  });
});
