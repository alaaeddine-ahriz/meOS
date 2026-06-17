import type { IngestQueueKind, JobQueue, KnowledgeStore } from "@meos/core";
import type { Cron } from "croner";
import type { ConnectorManager } from "../connector-manager.js";
import type { DurableIngest } from "../durable-ingest.js";
import type { FolderWatcher } from "../watcher.js";
import { errorMessage, type Worker, type WorkerHealth } from "./worker.js";

/**
 * Wraps the FolderWatcher. start/stop delegate unchanged; health reports whether
 * the watcher is currently watching any folders. The watcher's own work (reading
 * files, enqueuing ingest jobs) is observed via the ingest queue worker.
 */
export class WatcherWorker implements Worker {
  readonly name = "watcher";
  private started = false;
  private lastError: string | null = null;

  constructor(private readonly watcher: FolderWatcher) {}

  start(): void {
    try {
      this.watcher.start();
      this.started = true;
      this.lastError = null;
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.watcher.close();
    } finally {
      this.started = false;
    }
  }

  health(): WorkerHealth {
    // Prefer a runtime watcher error (EMFILE, etc.) over the start-time one:
    // the watcher starts fine, then errors asynchronously once it walks a tree
    // larger than the descriptor budget.
    const error = this.watcher.lastError ?? this.lastError;
    return {
      name: this.name,
      status: error ? "error" : this.started ? "idle" : "stopped",
      detail: this.started ? "watching registered folders" : "not watching",
      lastError: error,
      lastRunAt: null,
    };
  }
}

/**
 * Wraps the ConnectorManager. start/stop delegate to its timer scheduling
 * unchanged; health reports how many per-kind sync timers are currently armed.
 */
export class ConnectorSyncWorker implements Worker {
  readonly name = "connectors";
  private started = false;
  private lastError: string | null = null;

  constructor(private readonly connectors: ConnectorManager) {}

  start(): void {
    try {
      this.connectors.start();
      this.started = true;
      this.lastError = null;
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  stop(): void {
    this.connectors.stop();
    this.started = false;
  }

  health(): WorkerHealth {
    const timers = this.connectors.activeTimerCount();
    return {
      name: this.name,
      status: this.lastError ? "error" : this.started ? "idle" : "stopped",
      detail: this.started
        ? timers > 0
          ? `${timers} sync timer(s) armed`
          : "no enabled connectors"
        : "not started",
      lastError: this.lastError,
      lastRunAt: null,
    };
  }
}

/**
 * Wraps the croner Cron returned by startScheduler. The Cron is created already
 * scheduled, so `start` is a no-op (recorded for symmetry) and `stop` calls
 * Cron.stop(). health reads croner's own introspection (isBusy / previousRun /
 * nextRun) without altering the schedule.
 */
export class SchedulerWorker implements Worker {
  readonly name = "scheduler";
  private stopped = false;

  constructor(private readonly cron: Cron) {}

  start(): void {
    // The Cron is already scheduled by startScheduler(); nothing to (re)start.
  }

  stop(): void {
    this.cron.stop();
    this.stopped = true;
  }

  health(): WorkerHealth {
    const next = this.cron.nextRun();
    const previous = this.cron.previousRun();
    return {
      name: this.name,
      status: this.stopped ? "stopped" : this.cron.isBusy() ? "running" : "idle",
      detail: this.stopped
        ? "stopped"
        : next
          ? `next run ${next.toISOString()}`
          : "no upcoming run",
      lastError: null,
      lastRunAt: previous ? previous.toISOString() : null,
    };
  }
}

/**
 * A queue-driven worker: it has no start/stop of its own (the queue is created
 * with the context and drains as jobs are pushed). It exists purely so the
 * runtime surface reports queue health — depth + whether anything is processing
 * — for the ingest pipeline and wiki regeneration queues. `name`/`label` let one
 * class serve both the ingest and wiki queues.
 */
export class QueueWorker implements Worker {
  constructor(
    readonly name: string,
    private readonly queue: JobQueue,
    private readonly label: string,
  ) {}

  start(): void {
    // Queue lifecycle is owned by the context; nothing to start.
  }

  stop(): void {
    // The queue is not torn down here; draining is the context/process concern.
  }

  health(): WorkerHealth {
    const active = this.queue.active;
    const pending = this.queue.pending;
    return {
      name: this.name,
      status: active > 0 ? "running" : "idle",
      detail: `${this.label}: ${active} processing, ${pending} pending`,
      lastError: null,
      lastRunAt: null,
    };
  }
}

/**
 * The durable ingestion queue (#13), surfaced off the persisted `ingest_jobs`
 * table rather than the in-memory queue: it reports pending/processing depth
 * plus failed + dead-letter counts, and starts/stops the {@link DurableIngest}
 * sweep (startup recovery + periodic stale-job reclaim + retention). One class
 * serves both the `extraction` and `embedding` queues via `name`/`queueKind`.
 */
export class IngestQueueWorker implements Worker {
  constructor(
    readonly name: string,
    private readonly store: KnowledgeStore,
    private readonly queueKind: IngestQueueKind,
    private readonly durable?: DurableIngest,
  ) {}

  start(): void {
    // Only the worker that owns the durable sweep starts it (the extraction
    // queue); the embedding queue is health-only for now.
    this.durable?.start();
  }

  stop(): void {
    this.durable?.stop();
  }

  health(): WorkerHealth {
    // Read the extended metrics (#18) so the surface also carries retry depth and
    // the oldest-queued age, not just the #13 depth counters.
    const depth = this.store.ingestQueueMetrics().find((d) => d.queue === this.queueKind) ?? {
      queue: this.queueKind,
      pending: 0,
      processing: 0,
      failed: 0,
      deadLetter: 0,
      retrying: 0,
      completed: 0,
      avgDurationSeconds: 0,
      oldestQueuedAt: null,
    };
    const status: WorkerHealth["status"] =
      depth.deadLetter > 0 ? "error" : depth.processing > 0 ? "running" : "idle";
    return {
      name: this.name,
      status,
      detail:
        `${this.queueKind}: ${depth.processing} processing, ${depth.pending} pending, ` +
        `${depth.retrying} retrying, ${depth.deadLetter} dead-letter`,
      lastError: depth.deadLetter > 0 ? `${depth.deadLetter} job(s) in dead-letter` : null,
      lastRunAt: null,
      queue: {
        pending: depth.pending,
        processing: depth.processing,
        failed: depth.failed,
        deadLetter: depth.deadLetter,
        retrying: depth.retrying,
        oldestQueuedAt: depth.oldestQueuedAt,
      },
    };
  }
}
