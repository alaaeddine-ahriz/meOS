import { z } from "zod";

/**
 * The health status of a single background worker. `idle` means started and
 * waiting for work, `running` means actively processing, `stopped` means not
 * started (or shut down), and `error` means the last attempt to start/stop or
 * a recent run faulted (see `lastError`).
 */
export const WorkerStatusSchema = z.enum(["idle", "running", "stopped", "error"]);

/**
 * Per-queue depth + failure counters for a durable, persisted queue (#13). Only
 * the ingestion queue workers populate this; in-memory workers omit it.
 */
export const QueueDepthSchema = z.object({
  /** Jobs waiting to run. */
  pending: z.number(),
  /** Jobs running right now. */
  processing: z.number(),
  /** Jobs that failed their last attempt and will be retried. */
  failed: z.number(),
  /** Jobs that exhausted their retries and need a manual retry. */
  deadLetter: z.number(),
  /** Jobs that have failed at least once but are still under their retry budget (#18). */
  retrying: z.number().optional(),
  /** ISO timestamp of the oldest still-pending job, or null when drained (#18). */
  oldestQueuedAt: z.string().nullable().optional(),
});

/** One worker's introspected health, as surfaced by GET /api/runtime. */
export const WorkerHealthSchema = z.object({
  /** Stable identifier, e.g. "watcher", "connectors", "scheduler". */
  name: z.string(),
  status: WorkerStatusSchema,
  /** Human-readable one-liner about what the worker is currently doing. */
  detail: z.string().optional(),
  /** The last error message this worker recorded, or null if none. */
  lastError: z.string().nullable(),
  /** ISO timestamp of the worker's last activity/run, or null if never. */
  lastRunAt: z.string().nullable(),
  /** Durable-queue depth/failure counters, present only on the ingest queues (#13). */
  queue: QueueDepthSchema.optional(),
});

/** GET /api/runtime — the runtime graph's worker health snapshot. */
export const RuntimeHealthSchema = z.object({
  workers: z.array(WorkerHealthSchema),
});

export type QueueDepth = z.infer<typeof QueueDepthSchema>;
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;
export type WorkerHealth = z.infer<typeof WorkerHealthSchema>;
export type RuntimeHealth = z.infer<typeof RuntimeHealthSchema>;
