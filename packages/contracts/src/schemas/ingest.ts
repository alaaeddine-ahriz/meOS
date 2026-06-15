import { z } from "zod";
import { NumericIdParam, SourceRefSchema } from "./common.js";

/** POST /api/ingest/upload (multipart; response only) */
export const UploadAcceptedSchema = z.object({
  inboxItemId: z.number(),
  filename: z.string(),
});
export const UploadResponse = z.object({ accepted: z.array(UploadAcceptedSchema) });

/** GET /api/inbox */
export const InboxItemSchema = z.object({
  id: z.number(),
  /** The ingested document, once parsing has created one. Null while queued. */
  source_id: z.number().nullable(),
  title: z.string(),
  status: z.string(),
  detail: z.string().nullable(),
  /** Absolute path for watched files; null for uploads and pasted text. */
  path: z.string().nullable(),
  /** How many times this file has been ingested; > 1 means it changed and was re-read. */
  revision: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const InboxResponse = z.object({
  queuePending: z.number(),
  items: z.array(InboxItemSchema),
});

/** GET /api/sources/:id/diff */
export const SourceDiffParams = NumericIdParam;

export const DiffFileSchema = z.object({
  path: z.string(),
  kind: z.enum(["created", "updated"]),
  entityName: z.string().nullable(),
  entitySlug: z.string().nullable(),
});

export const SourceDiffResponse = z.object({
  source: SourceRefSchema,
  commits: z.array(
    z.object({
      hash: z.string(),
      subject: z.string(),
      committedAt: z.string(),
      files: z.array(DiffFileSchema),
      patch: z.string(),
    }),
  ),
});

// --- durable ingest jobs (#13) ---------------------------------------

/** The durable lifecycle state of an ingest job. */
export const IngestJobStateSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
  "dead-letter",
]);

/** GET /api/ingest/jobs — one persisted ingestion unit + its run history. */
export const IngestJobSchema = z.object({
  id: z.number(),
  kind: z.string(),
  queue: z.enum(["extraction", "embedding"]),
  stage: z.string(),
  state: IngestJobStateSchema,
  attempts: z.number(),
  maxAttempts: z.number(),
  inboxItemId: z.number().nullable(),
  sourceId: z.number().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const IngestJobsResponse = z.object({ jobs: z.array(IngestJobSchema) });

/** POST /api/ingest/jobs/:id/retry */
export const RetryJobParams = NumericIdParam;
export const RetryJobResponse = z.object({ retried: z.boolean() });

// --- ingestion observability metrics (#18) ---------------------------

/** Extended per-queue metrics: #13 depth counters + retry/throughput diagnostics. */
export const IngestQueueMetricsSchema = z.object({
  queue: z.enum(["extraction", "embedding"]),
  pending: z.number(),
  processing: z.number(),
  failed: z.number(),
  deadLetter: z.number(),
  /** Jobs that have failed at least once but are still under their retry budget. */
  retrying: z.number(),
  /** Jobs that finished successfully (and survive retention). */
  completed: z.number(),
  /** Mean wall-clock seconds of completed runs on this queue. */
  avgDurationSeconds: z.number(),
  /** ISO timestamp of the oldest still-pending job, or null when drained. */
  oldestQueuedAt: z.string().nullable(),
});

/** Per-stage timing + outcome counts aggregated from the run history. */
export const IngestStageMetricSchema = z.object({
  /** The pipeline stage (e.g. "indexing", "extraction", "merge"). */
  stage: z.string(),
  completed: z.number(),
  failed: z.number(),
  deadLetter: z.number(),
  processing: z.number(),
  avgDurationSeconds: z.number(),
  totalDurationSeconds: z.number(),
});

/** Stale-job recovery counters: reclaimed-from-crash and currently dead-lettered. */
export const IngestRecoveryMetricsSchema = z.object({
  recovered: z.number(),
  deadLettered: z.number(),
});

/** Per-extraction cost telemetry, grouped by (model, prompt version, strategy). */
export const IngestCostMetricSchema = z.object({
  modelId: z.string(),
  promptVersion: z.string(),
  strategy: z.enum(["single", "map-reduce"]),
  extractions: z.number(),
  /** Total tokens recorded (0 until token usage is populated upstream). */
  tokenUsage: z.number(),
  /** Best-effort estimated USD cost, or null when no rate is known for the model. */
  estimatedCostUsd: z.number().nullable(),
});

/** GET /api/ingest/metrics — the read-only ingestion observability surface (#18). */
export const IngestMetricsResponse = z.object({
  queues: z.array(IngestQueueMetricsSchema),
  stages: z.array(IngestStageMetricSchema),
  recovery: IngestRecoveryMetricsSchema,
  costs: z.array(IngestCostMetricSchema),
  /** Backpressure config in effect: the per-pump batch admission cap. */
  backpressure: z.object({ maxBatchesPerPump: z.number() }),
  /** When this snapshot was taken (ISO). */
  generatedAt: z.string(),
});

export type InboxItem = z.infer<typeof InboxItemSchema>;
export type SourceDiff = z.infer<typeof SourceDiffResponse>;
export type DiffFile = z.infer<typeof DiffFileSchema>;
export type IngestJob = z.infer<typeof IngestJobSchema>;
export type IngestJobState = z.infer<typeof IngestJobStateSchema>;
export type IngestQueueMetrics = z.infer<typeof IngestQueueMetricsSchema>;
export type IngestStageMetric = z.infer<typeof IngestStageMetricSchema>;
export type IngestRecoveryMetrics = z.infer<typeof IngestRecoveryMetricsSchema>;
export type IngestCostMetric = z.infer<typeof IngestCostMetricSchema>;
export type IngestMetrics = z.infer<typeof IngestMetricsResponse>;
