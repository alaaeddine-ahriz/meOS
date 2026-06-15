interface QueuedJob {
  job: () => Promise<void>;
  exclusive: boolean;
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
 */
export class JobQueue {
  private readonly waiting: QueuedJob[] = [];
  private running = 0;
  private exclusiveActive = false;
  private pendingCount = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly concurrency = 1) {}

  push(job: () => Promise<void>, options?: { exclusive?: boolean }): void {
    this.pendingCount++;
    this.waiting.push({ job, exclusive: options?.exclusive ?? false });
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
          console.error("[queue] job failed:", error);
        })
        .finally(() => {
          this.running--;
          this.pendingCount--;
          if (next.exclusive) this.exclusiveActive = false;
          this.drain();
          if (this.running === 0 && this.waiting.length === 0) {
            for (const resolve of this.idleResolvers.splice(0)) resolve();
          }
        });
    }
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
    if (this.running === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }
}

/** @deprecated Use JobQueue — kept as an alias for existing imports. */
export const SerialQueue = JobQueue;
export type SerialQueue = JobQueue;
