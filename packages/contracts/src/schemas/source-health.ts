import { z } from "zod";
import { ConnectorKindSchema, CoverageStateSchema } from "./connectors.js";

/**
 * The Source health dashboard (#87): one user-facing answer to "Did meOS read the
 * right things? What's missing? What should I fix?" — composed read-only from the
 * existing ingest-metrics, connector sync-state, and watched-folder aggregates.
 *
 * Everything here is product language, not implementation jargon: a "category" is
 * a place meOS reads from (a watched folder group, or a connected service), and a
 * "health" label tells the user at a glance whether it's fine, needs attention, or
 * is disconnected.
 */

/** A category's at-a-glance health (#87): product terms, not worker states. */
export const HealthLabelSchema = z.enum(["healthy", "degraded", "disconnected"]);

/** Per-category item counts (#87): the indexed/failed/skipped/pending breakdown. */
export const SourceCountsSchema = z.object({
  /** Items successfully indexed. */
  indexed: z.number(),
  /** Items that failed to index (and may be retryable). */
  failed: z.number(),
  /** Items intentionally skipped (unsupported type, excluded, unchanged). */
  skipped: z.number(),
  /** Items removed upstream and retired locally. */
  deleted: z.number(),
  /** Items queued and not yet processed. */
  pending: z.number(),
});

/** The local-folders category (#87): watched paths + their indexing health. */
export const LocalFoldersHealthSchema = z.object({
  health: HealthLabelSchema,
  /** The folders meOS is watching. */
  folders: z.array(z.object({ id: z.number(), path: z.string() })),
  counts: SourceCountsSchema,
  /** ISO timestamp of the most recent successful index, or null. */
  lastIndexedAt: z.string().nullable(),
  /** A watcher-level error (e.g. too many open files), or null when healthy. */
  watcherError: z.string().nullable(),
});

/** One connector kind's health (#87), drawn from its sync state (#88). */
export const ConnectorHealthSchema = z.object({
  kind: ConnectorKindSchema,
  /** Product label for the kind (e.g. "Emails", "Calendar events"). */
  label: z.string(),
  health: HealthLabelSchema,
  enabled: z.boolean(),
  /** The unambiguous completeness state from #88. */
  state: CoverageStateSchema,
  counts: SourceCountsSchema,
  /** ISO timestamp of the last SUCCESSFUL sync, or null. */
  lastSuccessAt: z.string().nullable(),
  /** ISO timestamp of the last FAILED sync, or null. */
  lastFailureAt: z.string().nullable(),
  /** The last error message, when the most recent attempt failed. */
  lastError: z.string().nullable(),
});

/** The connectors category (#87): the connected account + its per-kind health. */
export const ConnectorsHealthSchema = z.object({
  /** Whether a Google account is connected at all. */
  connected: z.boolean(),
  accountEmail: z.string().nullable(),
  health: HealthLabelSchema,
  kinds: z.array(ConnectorHealthSchema),
});

/** A job currently being processed (#87) — the "currently syncing/indexing" view. */
export const RunningJobSchema = z.object({
  id: z.number(),
  /** What kind of work (e.g. "file", "connector"). */
  kind: z.string(),
  /** The pipeline stage in progress (e.g. "extraction"). */
  stage: z.string(),
});

/** A recent failure the user can inspect and retry (#87). */
export const RecentFailureSchema = z.object({
  /** The ingest job id — pass to POST /api/ingest/jobs/:id/retry. */
  id: z.number(),
  kind: z.string(),
  stage: z.string(),
  /** "failed" (will retry) or "dead-letter" (needs a manual retry). */
  state: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
  lastError: z.string().nullable(),
  updatedAt: z.string(),
  /** True when the user can retry it from the dashboard. */
  retryable: z.boolean(),
});

/** Overall queue/pipeline health (#87): the running + backlog + failure totals. */
export const PipelineHealthSchema = z.object({
  health: HealthLabelSchema,
  running: z.number(),
  pending: z.number(),
  failed: z.number(),
  deadLetter: z.number(),
});

/** A file extension meOS does not index, with how many it has seen (#87). */
export const SkippedTypeSchema = z.object({
  /** The file extension (lowercased, no dot), e.g. "zip". */
  extension: z.string(),
  count: z.number(),
});

/**
 * The automatic provider hold (#circuit): set when ingestion pauses itself
 * because the intelligence provider is unusable (out of credits, rejected key,
 * unknown model). Lets the dashboard show ONE actionable banner instead of the
 * same error repeated on every file.
 */
export const ProviderHoldSchema = z.object({
  /** A ready-to-show, already-friendly reason (e.g. "…out of credits or quota…"). */
  reason: z.string(),
  /** The error classification: "auth" | "credits" | "model" (an LlmErrorKind). */
  kind: z.string(),
  /** ISO timestamp the hold engaged. */
  since: z.string(),
});

/** GET /api/source-health — the whole dashboard payload (#87). */
export const SourceHealthResponse = z.object({
  localFolders: LocalFoldersHealthSchema,
  connectors: ConnectorsHealthSchema,
  pipeline: PipelineHealthSchema,
  /** Jobs in flight right now. */
  runningJobs: z.array(RunningJobSchema),
  /** Recent failures, newest first, with enough info to retry. */
  recentFailures: z.array(RecentFailureSchema),
  /** Unsupported/skipped file types meOS has encountered. */
  skippedTypes: z.array(SkippedTypeSchema),
  /**
   * Set when ingestion has auto-paused itself because the AI provider isn't
   * working (#circuit); null when the provider is fine. The single most important
   * thing to surface — it explains why nothing is being read and how to fix it.
   */
  providerHold: ProviderHoldSchema.nullable(),
  /** When this snapshot was taken (ISO). */
  generatedAt: z.string(),
});

export type HealthLabel = z.infer<typeof HealthLabelSchema>;
export type SourceCounts = z.infer<typeof SourceCountsSchema>;
export type LocalFoldersHealth = z.infer<typeof LocalFoldersHealthSchema>;
export type ConnectorHealth = z.infer<typeof ConnectorHealthSchema>;
export type ConnectorsHealth = z.infer<typeof ConnectorsHealthSchema>;
export type RunningJob = z.infer<typeof RunningJobSchema>;
export type RecentFailure = z.infer<typeof RecentFailureSchema>;
export type PipelineHealth = z.infer<typeof PipelineHealthSchema>;
export type SkippedType = z.infer<typeof SkippedTypeSchema>;
export type ProviderHold = z.infer<typeof ProviderHoldSchema>;
export type SourceHealth = z.infer<typeof SourceHealthResponse>;
