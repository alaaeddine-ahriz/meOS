/**
 * A counting semaphore: at most `permits` holders run concurrently, the rest
 * queue FIFO until a permit frees.
 *
 * Used to cap how many file descriptors the ingest paths hold open at once. The
 * {@link JobQueue}'s concurrency bounds the number of *jobs*, but that isn't the
 * same as bounding open files: the watcher stats files outside the queue (a
 * burst of FS events fans out into many simultaneous `stat`s), and a single job
 * can open files of its own. Without a descriptor budget a large copy — or an
 * `npm install` in a watched folder — can exhaust the process limit and throw
 * EMFILE. One shared semaphore across those paths keeps total open files bounded
 * no matter how the bursts arrive.
 */
export class Semaphore {
  private available: number;
  /** FIFO queue of acquirers waiting for a permit. */
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore needs at least 1 permit, got ${permits}`);
    }
    this.available = permits;
  }

  /** Run `fn` once a permit is free, always releasing it (even if `fn` throws). */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    // Hand the permit straight to the next waiter rather than incrementing then
    // decrementing, so a permit is never momentarily visible as free while work
    // is queued behind it.
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }
}
