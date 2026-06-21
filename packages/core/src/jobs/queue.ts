import { createLogger } from "../logger.js";

const log = createLogger("queue");

/**
 * Work-type priority classes for ingest scheduling (#18). A higher number drains
 * first; within a class the queue stays strictly FIFO, so ordering is
 * deterministic. The ladder mirrors the issue's intent: a user-uploaded note
 * outranks a watched file, which outranks a connector background sync, which
 * outranks nightly maintenance.
 */
export const JobPriority = {
  /** User-typed note / direct upload — the user is waiting on it. */
  USER: 40,
  /** A watched file landed on disk. */
  WATCH: 30,
  /** Background connector sync (Gmail/Calendar/Contacts). */
  CONNECTOR: 20,
  /** Nightly maintenance / consolidation / backfill. */
  NIGHTLY: 10,
} as const;

/** The default priority for jobs pushed without an explicit class. */
export const DEFAULT_PRIORITY = JobPriority.WATCH;

interface QueuedJob {
  job: () => Promise<void>;
  exclusive: boolean;
  priority: number;
  /** Insertion order, so ties within a priority class stay strictly FIFO. */
  seq: number;
}

/**
 * In-process background job queue with bounded concurrency. API handlers
 * return immediately (the UI never blocks); jobs run in the background, at
 * most `concurrency` at a time. The default of 1 preserves strict FIFO
 * ordering; the server runs ingestion at a higher concurrency since the
 * pipeline serializes its own merge step.
 *
 * Jobs pushed with `exclusive: true` (e.g. nightly consolidation) wait for
 * everything in flight to finish, run alone, and hold the queue until done.
 *
 * Jobs carry a `priority` class (#18): higher priority work is dequeued first
 * so a large low-priority import cannot starve a user note or manual action.
 * Within a class the queue is strictly FIFO (insertion order breaks ties), so
 * scheduling stays deterministic and testable.
 */
export class JobQueue {
  private readonly waiting: QueuedJob[] = [];
  private running = 0;
  private exclusiveActive = false;
  private pendingCount = 0;
  private idleResolvers: Array<() => void> = [];
  /** Monotonic insertion counter for stable FIFO tie-breaking within a class. */
  private seqCounter = 0;

  constructor(private readonly concurrency = 1) {}

  push(job: () => Promise<void>, options?: { exclusive?: boolean; priority?: number }): void {
    this.pendingCount++;
    const entry: QueuedJob = {
      job,
      exclusive: options?.exclusive ?? false,
      priority: options?.priority ?? DEFAULT_PRIORITY,
      seq: this.seqCounter++,
    };
    // Insertion-sort by (priority desc, seq asc) so dequeue is a cheap shift and
    // ordering is fully deterministic. An exclusive job keeps its arrival slot
    // among its peers — it still waits for in-flight work to clear at drain time.
    let i = this.waiting.length;
    while (i > 0) {
      const prev = this.waiting[i - 1]!;
      if (prev.priority > entry.priority) break;
      if (prev.priority === entry.priority && prev.seq < entry.seq) break;
      i--;
    }
    this.waiting.splice(i, 0, entry);
    this.drain();
  }

  private drain(): void {
    while (this.waiting.length > 0 && !this.exclusiveActive) {
      const next = this.waiting[0]!;
      if (next.exclusive) {
        if (this.running > 0) return; // wait for in-flight jobs to clear
        this.exclusiveActive = true;
      } else if (this.running >= this.concurrency) {
        return;
      }
      this.waiting.shift();
      this.running++;
      next
        .job()
        .catch((error) => {
          log.error({ err: error }, "job failed");
        })
        .finally(() => {
          this.running--;
          this.pendingCount--;
          if (next.exclusive) this.exclusiveActive = false;
          this.drain();
          if (this.isIdle) {
            for (const resolve of this.idleResolvers.splice(0)) resolve();
          }
        });
    }
  }

  /** True when nothing is running and nothing is waiting — the queue has drained. */
  private get isIdle(): boolean {
    return this.running === 0 && this.waiting.length === 0;
  }

  get pending(): number {
    return this.pendingCount;
  }

  /** How many jobs are executing right now (for runtime introspection). */
  get active(): number {
    return this.running;
  }

  /** Resolves once every job queued so far has finished. */
  onIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }
}

/** @deprecated Use JobQueue — kept as an alias for existing imports. */
export const SerialQueue = JobQueue;
export type SerialQueue = JobQueue;
