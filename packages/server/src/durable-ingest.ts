import fs from "node:fs";
import path from "node:path";
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

  /**
   * Where the raw bytes of an upload/paste are spilled so ANY process can
   * reconstruct the input. The in-memory {@link liveInputs} buffer only exists in
   * the enqueueing process; once heavy work moved to a forked worker, a job the
   * app enqueued has no live buffer in the worker that claims it. Watched files
   * recover from their on-disk `path`; uploads (no path) and pastes (text) had
   * nothing — so we persist them next to the DB, keyed by job id.
   */
  private readonly stagingDir: string;

  constructor(
    private readonly deps: {
      store: KnowledgeStore;
      pipeline: IngestionPipeline;
      queue: JobQueue;
      /** Directory for spilled upload/paste bytes (cross-process recovery). */
      stagingDir: string;
      /** Backpressure cap on jobs admitted per pump pass; defaults to 20. */
      maxBatchesPerPump?: number;
    },
  ) {
    this.maxBatchesPerPump = deps.maxBatchesPerPump ?? MAX_BATCHES_PER_PUMP;
    this.stagingDir = deps.stagingDir;
    fs.mkdirSync(this.stagingDir, { recursive: true });
  }

  /** The on-disk staging path for a job's spilled input bytes. */
  private stagingPath(jobId: number): string {
    return path.join(this.stagingDir, String(jobId));
  }

  /** Best-effort removal of a job's spilled bytes once it no longer needs them. */
  private discardStaging(jobId: number): void {
    try {
      fs.rmSync(this.stagingPath(jobId), { force: true });
    } catch {
      /* a missing/already-removed staging file is fine */
    }
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
    // A watched file recovers from its on-disk `path`; an upload has none, so
    // spill its bytes for any process to reconstruct. Written before the pump
    // signal so a worker that claims on the signal always finds the file.
    if (!input.path) fs.writeFileSync(this.stagingPath(jobId), input.buffer);
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
    // Pasted text has no source file to re-read, so always spill it for
    // cross-process recovery (the worker that claims it has no live buffer).
    fs.writeFileSync(this.stagingPath(jobId), input.text, "utf8");
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
    this.pruneStagingFiles();
    this.timer = setInterval(() => {
      this.deps.store.recoverStaleIngestJobs(STALE_GRACE_SECONDS);
      this.deps.store.pruneCompletedIngestJobs(RETENTION_DAYS);
      this.pruneStagingFiles();
      this.pump();
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  /**
   * Backstop cleanup for spilled staging bytes: eager discard on completion
   * covers the happy path, but a crash between completing a job and discarding
   * its file would orphan bytes. Drop any staging file whose job is gone or
   * terminal (completed / dead-letter); keep files for jobs still pending,
   * processing, or awaiting retry (they need the bytes on the next run).
   */
  private pruneStagingFiles(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.stagingDir);
    } catch {
      return;
    }
    for (const name of entries) {
      const jobId = Number(name);
      if (!Number.isInteger(jobId)) continue;
      const job = this.deps.store.getIngestJob(jobId);
      if (!job || job.state === "completed" || job.state === "dead-letter") {
        this.discardStaging(jobId);
      }
    }
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
      // Upload/paste: reconstruct from the spilled staging bytes. This is the
      // cross-process recovery path — the worker process that claimed the job
      // never held the live buffer, and after a crash liveInputs is empty.
      const staged = this.stagingPath(job.id);
      if (fs.existsSync(staged)) {
        const inboxItemId = job.inbox_item_id ?? undefined;
        if (payload?.kind === "file") {
          const buffer = await fs.promises.readFile(staged);
          await this.runIngest(
            job,
            { kind: "file", filename: payload.filename, buffer, origin: payload.origin },
            inboxItemId,
          );
          return;
        }
        if (payload?.kind === "text") {
          const text = await fs.promises.readFile(staged, "utf8");
          await this.runIngest(job, { kind: "text", title: payload.title, text }, inboxItemId);
          return;
        }
      }
      // No path, no source, no staged bytes (a pre-spill upload lost to a crash):
      // nothing to recover from, dead-letter it directly.
      throw new Error("cannot recover ingest input (no path, source, or staged bytes)");
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
        // Terminal success: the spilled bytes are no longer needed (the sweep is
        // the backstop for any we miss after a crash).
        this.discardStaging(job.id);
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
      // even if no new ingest arrives to drive the queue. Keep the staged bytes:
      // the retry re-runs from them.
      setTimeout(() => this.pump(), 1500).unref();
    } else {
      // Terminal failure (dead-letter): the bytes will never be re-run, drop them.
      this.discardStaging(job.id);
    }
  }
}
