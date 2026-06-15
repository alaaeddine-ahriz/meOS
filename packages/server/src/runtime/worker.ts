import type { WorkerHealth, WorkerStatus } from "@meos/contracts";

export type { WorkerHealth, WorkerStatus };

/**
 * A single background component of the local monolith, exposed behind a uniform
 * lifecycle + introspection surface. Wrapping each worker this way makes the
 * runtime legible (see `docs/runtime.md`): the process is a registry of named
 * workers rather than a set of ad-hoc `start()`/`stop()` calls scattered through
 * `main.ts`.
 *
 * Wrappers are BEHAVIOR-PRESERVING: `start`/`stop` delegate to the underlying
 * component unchanged, and `health()` only reads existing state (queue depth,
 * cron next-run, last error). Queue-driven workers that have no meaningful
 * start/stop of their own implement them as no-ops and report health off the
 * shared ingest/wiki queues.
 */
export interface Worker {
  /** Stable identifier, e.g. "watcher", "connectors", "scheduler". */
  readonly name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  /** A point-in-time, read-only health snapshot — never mutates the worker. */
  health(): WorkerHealth;
}

/**
 * A small registry of workers held on the app context as `ctx.workers`.
 * `main.ts` drives the process lifecycle through `startAll`/`stopAll` (preserving
 * the exact watcher → connectors → scheduler ordering), and the `/api/runtime`
 * route reads `health()` off every registered worker.
 */
export class WorkerRegistry {
  private readonly workers: Worker[] = [];

  /** Register workers in the order they should start. */
  register(...workers: Worker[]): void {
    this.workers.push(...workers);
  }

  list(): readonly Worker[] {
    return this.workers;
  }

  get(name: string): Worker | undefined {
    return this.workers.find((w) => w.name === name);
  }

  /** Start every worker in registration order (watcher → connectors → scheduler). */
  async startAll(): Promise<void> {
    for (const worker of this.workers) await worker.start();
  }

  /** Stop every worker in reverse registration order. */
  async stopAll(): Promise<void> {
    for (const worker of [...this.workers].reverse()) await worker.stop();
  }

  /** A read-only health snapshot of every registered worker. */
  health(): WorkerHealth[] {
    return this.workers.map((w) => w.health());
  }
}

/** Reduce an unknown thrown value to a stable message string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
