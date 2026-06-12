/**
 * Serial in-process job queue: ingestion and maintenance run one at a time in
 * the background so API handlers can return immediately (the UI never blocks).
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;

  push(job: () => Promise<void>): void {
    this.pendingCount++;
    this.tail = this.tail
      .then(job)
      .catch((error) => {
        console.error("[queue] job failed:", error);
      })
      .finally(() => {
        this.pendingCount--;
      });
  }

  get pending(): number {
    return this.pendingCount;
  }

  /** Resolves once every job queued so far has finished. */
  onIdle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
