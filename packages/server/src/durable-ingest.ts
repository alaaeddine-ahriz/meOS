import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  IngestPriority,
  type IngestInput,
  type IngestJobRow,
  type IngestionPipeline,
  type JobQueue,
  type KnowledgeStore,
} from "@meos/core";

/** The JSON shape persisted in `ingest_jobs.payload` (a pointer, never bytes). */
type JobPayload =
  | { kind: "file"; filename: string; path?: string; origin?: string }
  | { kind: "text"; title: string };

/**
 * How often the durable layer sweeps for stale `processing` jobs (a worker that
 * crashed mid-run) and re-pumps the persisted queues. On each tick a job left in
 * `processing` past the grace window is returned to `pending` and re-run.
 */
const SWEEP_INTERVAL_MS = 30_000;
/** A job in `processing` longer than this is presumed crashed and reclaimed. */
const STALE_GRACE_SECONDS = 120;
/** Retention: completed jobs/runs older than this are pruned on each sweep. */
const RETENTION_DAYS = 7;
/**
 * Backpressure (#18): the most jobs a single {@link DurableIngest.pump} admits
 * onto the executor in one pass. A 1000-file bulk import therefore drips onto
 * the queue a batch at a time — the next batch is admitted by the very `pump`
 * that runs when a job finishes (see {@link execute}) plus the periodic sweep —
 * so retries, manual actions, and other queues are never starved while a large
 * import drains. Highest-priority pending work is always admitted first.
 */
const MAX_BATCHES_PER_PUMP = 20;

/**
 * The durable, resumable ingestion layer (#13). Each ingestion unit is persisted
 * as an `ingest_jobs` row before any work runs, so a crash/restart loses nothing:
 * the in-memory {@link JobQueue} is only the concurrency executor, while the DB
 * rows are the source of truth. Search/index is committed independently of
 * semantic extraction, so a source becomes searchable even when extraction
 * fails — and the extraction stage is then retried on its own.
 *
 * Behaviour is preserved: callers (watcher, upload route) still get an immediate
 * return; the pipeline still serialises merges through its own `mergeLock`.
 */
export class DurableIngest {
  private timer: NodeJS.Timeout | null = null;
  /** Set once {@link stop} runs, so a deferred pump after shutdown is a no-op. */
  private stopped = false;
  /**
   * The live input for freshly-enqueued jobs, so the first run uses the buffer
   * already in memory (no disk read). Dropped once the job is claimed; a later
   * recovery/retry reconstructs the input from the path or stored source instead.
   */
  private readonly liveInputs = new Map<number, IngestInput>();

  /** Per-pump admission cap for backpressure (#18); overridable for tests. */
  private readonly maxBatchesPerPump: number;

  constructor(
    private readonly deps: {
      store: KnowledgeStore;
      pipeline: IngestionPipeline;
      queue: JobQueue;
      /** Backpressure cap on jobs admitted per pump pass; defaults to 20. */
      maxBatchesPerPump?: number;
    },
  ) {
    this.maxBatchesPerPump = deps.maxBatchesPerPump ?? MAX_BATCHES_PER_PUMP;
  }

  /** The active per-pump batch admission cap (backpressure), for the metrics surface (#18). */
  get batchCap(): number {
    return this.maxBatchesPerPump;
  }

  /**
   * Persist + enqueue a file/upload ingest. The buffer is held only for this
   * run (it stays on disk for watched files); the persisted payload references
   * the path so a crash mid-run is recoverable by re-reading. Returns the job id.
   */
  enqueueFile(input: {
    filename: string;
    buffer: Buffer;
    origin?: string;
    path?: string;
    inboxItemId: number;
    /** Priority class (#18); defaults by origin — watched files below uploads. */
    priority?: number;
  }): number {
    const payload: JobPayload = {
      kind: "file",
      filename: input.filename,
      path: input.path,
      origin: input.origin,
    };
    const jobId = this.deps.store.createIngestJob({
      kind: "file",
      queue: "extraction",
      payload,
      inboxItemId: input.inboxItemId,
      contentHash: createHash("sha256").update(input.buffer).digest("hex"),
      byteSize: input.buffer.byteLength,
      // A watched file is background work; an upload is the user waiting on it.
      priority:
        input.priority ?? (input.origin === "watch" ? IngestPriority.WATCH : IngestPriority.USER),
    });
    this.liveInputs.set(jobId, {
      kind: "file",
      filename: input.filename,
      buffer: input.buffer,
      origin: input.origin,
      path: input.path,
    });
    this.pump();
    return jobId;
  }

  /** Persist + enqueue a pasted-text ingest. A user note is high-priority (#18). */
  enqueueText(input: {
    title: string;
    text: string;
    origin?: string;
    inboxItemId: number;
    /** Priority class (#18); defaults to the user class (a note being typed). */
    priority?: number;
  }): number {
    const payload: JobPayload = { kind: "text", title: input.title };
    const jobId = this.deps.store.createIngestJob({
      kind: "text",
      queue: "extraction",
      payload,
      inboxItemId: input.inboxItemId,
      contentHash: createHash("sha256").update(input.text).digest("hex"),
      byteSize: Buffer.byteLength(input.text),
      priority: input.priority ?? IngestPriority.USER,
    });
    this.liveInputs.set(jobId, {
      kind: "text",
      title: input.title,
      text: input.text,
      origin: input.origin,
    });
    this.pump();
    return jobId;
  }

  /**
   * Manually retry a failed/dead-letter job: reset its retry budget and re-pump.
   * Returns false if the job is unknown or not in a retryable state. The re-pump
   * is deferred to the next tick so the job is observably `pending` the moment
   * this returns (the UI/contract reads it back immediately); the executor then
   * claims it asynchronously, exactly like a freshly enqueued ingest.
   */
  retry(jobId: number): boolean {
    if (!this.deps.store.retryIngestJob(jobId)) return false;
    setTimeout(() => this.pump(), 0).unref();
    return true;
  }

  /** Start the periodic sweep: recover stale jobs, re-pump, prune old history. */
  start(): void {
    this.stopped = false;
    // Startup recovery: any job left `processing` by a previous crash returns to
    // `pending` (grace 0 — nothing is legitimately in flight at boot).
    this.deps.store.recoverStaleIngestJobs(0);
    this.pump();
    this.timer = setInterval(() => {
      this.deps.store.recoverStaleIngestJobs(STALE_GRACE_SECONDS);
      this.deps.store.pruneCompletedIngestJobs(RETENTION_DAYS);
      this.pump();
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Admit up to {@link maxBatchesPerPump} runnable persisted extraction jobs onto
   * the executor, highest priority first (backpressure, #18). Capping the per-
   * pass admission means a large bulk import cannot flood the in-memory queue and
   * starve retries, manual actions, or other work: the next batch is admitted by
   * the re-pump that runs when a job finishes (see {@link execute}) and by the
   * periodic sweep, so the import still drains fully — just a batch at a time.
   *
   * Best-effort: a deferred pump (retry/sweep) can fire after the DB has been
   * closed (e.g. on shutdown), so a closed connection is a no-op rather than a
   * crash — there is nothing to drain once the store is gone.
   */
  pump(): void {
    if (this.stopped || !this.deps.store.db.open) return;
    let admitted = 0;
    while (admitted < this.maxBatchesPerPump) {
      const job = this.deps.store.claimIngestJob("extraction");
      if (!job) return;
      admitted++;
      this.deps.queue.push(() => this.execute(job), { priority: job.priority });
    }
  }

  /**
   * Run an already-claimed job. The input is the live buffer if this is the
   * job's first run, otherwise it is reconstructed: re-read the file by path, or
   * — for a source that already indexed — retry just the extraction stage from
   * the stored revision content (no re-read, no re-chunk).
   */
  private async execute(job: IngestJobRow): Promise<void> {
    const payload = job.payload ? (JSON.parse(job.payload) as JobPayload) : null;
    const live = this.liveInputs.get(job.id);
    this.liveInputs.delete(job.id);
    try {
      if (live) {
        await this.runIngest(job, live, job.inbox_item_id ?? undefined);
        return;
      }
      // A job that already produced a source only needs its extraction retried
      // — the index already landed, so never re-read or re-chunk.
      if (job.source_id) {
        const merge = await this.deps.pipeline.retryExtractionForSource(
          job.source_id,
          job.inbox_item_id ?? undefined,
        );
        if (merge === null) throw new Error("source has no recoverable content to re-extract");
        this.deps.store.completeIngestJob(job.id, "done");
        return;
      }
      if (payload?.kind === "file" && payload.path) {
        const buffer = await fs.promises.readFile(payload.path);
        await this.runIngest(
          job,
          {
            kind: "file",
            filename: payload.filename,
            buffer,
            origin: payload.origin,
            path: payload.path,
          },
          job.inbox_item_id ?? undefined,
        );
        return;
      }
      // An upload (no path) whose buffer is gone after a crash: nothing to
      // recover from, dead-letter it directly.
      throw new Error("cannot recover ingest input (no path and no source)");
    } catch (error) {
      this.fail(job, error);
    } finally {
      // Backpressure (#18): each finished job frees a per-pump admission slot, so
      // re-pump to admit the next batch of a capped large import. Deferred to the
      // next tick so this runs after the executor records this job as done.
      setTimeout(() => this.pump(), 0).unref();
    }
  }

  /** Run the full pipeline for a job and persist its outcome. */
  private async runIngest(
    job: IngestJobRow,
    input: IngestInput,
    inboxItemId: number | undefined,
  ): Promise<void> {
    try {
      this.deps.store.setIngestJobStage(job.id, "indexing");
      const outcome = await this.deps.pipeline.ingest(input, inboxItemId);
      if (outcome.sourceId) {
        this.deps.store.setIngestJobSource(job.id, outcome.sourceId, outcome.sourceRevisionId);
      }
      if (outcome.status === "done" || outcome.status === "unsupported") {
        this.deps.store.completeIngestJob(
          job.id,
          outcome.status === "done" ? "done" : "unsupported",
        );
      } else if (outcome.status === "indexed") {
        // Searchable, but extraction failed: record a retryable failure so the
        // extraction stage re-runs (now keyed by source_id, so no re-read).
        this.fail(job, new Error("semantic extraction failed (source is searchable)"));
      } else {
        this.fail(job, new Error("ingestion failed"));
      }
    } catch (error) {
      this.fail(job, error);
    }
  }

  private fail(job: IngestJobRow, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const state = this.deps.store.failIngestJob(job.id, message);
    if (state === "pending") {
      // Re-pump after the backoff window elapses so the retry actually fires
      // even if no new ingest arrives to drive the queue.
      setTimeout(() => this.pump(), 1500).unref();
    }
  }
}
