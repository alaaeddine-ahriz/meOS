import { z } from "zod";

export const ConnectorKindSchema = z.enum(["contacts", "calendar", "gmail", "tasks"]);

/** How far back a kind indexes (#68). "recent" is the safe default seed. */
export const CoverageWindowSchema = z.enum(["recent", "30d", "90d", "1y", "all"]);

/** Gmail content depth (#68): metadata-only (default, private) vs richer opt-in. */
export const GmailContentModeSchema = z.enum(["metadata", "rich"]);

/** One Google Tasks task list (selection + the create-task default list). */
export const TaskListSchema = z.object({
  id: z.string(),
  title: z.string(),
});

/**
 * What happens to a kind's synced items — the "enable one of two" choice made
 * when connecting a service:
 *  - "index": items are indexed locally as linked entities/sources (the Sources
 *    tab) and read by the wiki-maintainer as source material, but a connector
 *    sync does not itself author/rewrite wiki pages.
 *  - "wiki": additionally drive wiki regeneration so the synced facts are woven
 *    into wiki prose proactively (the heavier path).
 */
export const IndexModeSchema = z.enum(["index", "wiki"]);

/** Resumable Gmail backfill progress, surfaced so partial coverage is obvious (#68). */
export const GmailBackfillProgressSchema = z.object({
  /** Items indexed by the historical backfill so far. */
  indexed: z.number(),
  /** Oldest indexed message date (ISO), or null. */
  oldestIndexed: z.string().nullable(),
  /** True once the backfill has covered the whole window. */
  complete: z.boolean(),
});

/**
 * The user-facing completeness state of a kind's sync (#88) — never an ambiguous
 * "connected"-only state. See `deriveCoverageState` in core for the rules.
 */
export const CoverageStateSchema = z.enum([
  "complete",
  "partial",
  "recent-only",
  "failed",
  "backfilling",
  "idle",
]);

/** Structured metrics from the last sync run (#88), surfaced for the dashboard. */
export const ConnectorSyncMetricsSchema = z.object({
  /** ISO timestamp of the last sync ATTEMPT (success or failure). */
  at: z.string(),
  ok: z.boolean(),
  indexed: z.number(),
  skipped: z.number(),
  deleted: z.number(),
  failed: z.number().optional(),
  /** ISO timestamp of the last SUCCESS (preserved across later failures). */
  okAt: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  /** ISO timestamp of the last FAILURE. */
  errorAt: z.string().nullable().optional(),
});

/** One of the user's Google calendars, for the multi-calendar picker (#68). */
export const CalendarListEntrySchema = z.object({
  id: z.string(),
  summary: z.string(),
  primary: z.boolean(),
  accessRole: z.string().optional(),
  backgroundColor: z.string().optional(),
});

/** Per-calendar sync progress (#68). */
export const CalendarCoverageSchema = z.object({
  id: z.string(),
  /** Events indexed for this calendar. */
  indexed: z.number(),
  lastSyncedAt: z.string().nullable(),
});

/**
 * Additive coverage info for a kind (#68). All fields optional so a client that
 * predates them still parses the status. Gmail and Calendar populate disjoint
 * subsets; both expose item counts + oldest-indexed date + last sync time/status.
 */
export const ConnectorCoverageSchema = z.object({
  /** Distinct items indexed for this kind. */
  itemCount: z.number().optional(),
  /** Oldest indexed item's date (ISO), or null. */
  oldestIndexed: z.string().nullable().optional(),
  /** The chosen coverage window. */
  coverageWindow: CoverageWindowSchema.optional(),
  /** The derived completeness state (#88) — the unambiguous status the UI shows. */
  state: CoverageStateSchema.optional(),
  /** ISO timestamp of the last SUCCESSFUL sync (#88), or null. */
  lastSuccessAt: z.string().nullable().optional(),
  /** ISO timestamp of the last FAILED sync (#88), or null. */
  lastFailureAt: z.string().nullable().optional(),
  /** The last error message, when the most recent attempt failed (#88). */
  lastError: z.string().nullable().optional(),
  /** Items materialized/updated on the last successful run (#88). */
  lastIndexed: z.number().optional(),
  /** Items unchanged (skipped) on the last successful run (#88). */
  lastSkipped: z.number().optional(),
  /** Items that failed on the last run (#88; reserved). */
  lastFailed: z.number().optional(),
  // --- gmail ---
  contentMode: GmailContentModeSchema.optional(),
  backfill: GmailBackfillProgressSchema.optional(),
  /** Gmail label ids/names to include (#88). */
  includeLabels: z.array(z.string()).optional(),
  /** Gmail label ids/names to exclude (#88). */
  excludeLabels: z.array(z.string()).optional(),
  // --- calendar ---
  availableCalendars: z.array(CalendarListEntrySchema).optional(),
  enabledCalendars: z.array(z.string()).optional(),
  calendars: z.array(CalendarCoverageSchema).optional(),
  // --- tasks ---
  /** The account's available task lists, for the selection UI (#88). */
  availableTaskLists: z.array(TaskListSchema).optional(),
  /** Task-list ids the user enabled (#88). Empty ⇒ all lists. */
  enabledTaskLists: z.array(z.string()).optional(),
});

export const ConnectorKindStatusSchema = z.object({
  kind: ConnectorKindSchema,
  enabled: z.boolean(),
  intervalMinutes: z.number(),
  /** The index/wiki mode for this kind. Defaults to "index" when unset. */
  mode: IndexModeSchema.optional(),
  lastSyncedAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  /** Coverage/progress info (#68); additive, may be absent on older servers. */
  coverage: ConnectorCoverageSchema.optional(),
});

/** GET /api/connectors and the response of most connector mutations. */
export const ConnectorStatusSchema = z.object({
  google: z.object({
    connected: z.boolean(),
    accountEmail: z.string().nullable(),
    hasCredentials: z.boolean(),
    kinds: z.array(ConnectorKindStatusSchema),
  }),
});

/** PUT /api/connectors/google/credentials */
export const GoogleCredentialsBody = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

/** POST /api/connectors/google/auth/start */
export const AuthStartResponse = z.object({ url: z.string() });

/** GET /api/connectors/google/callback */
export const ConnectorCallbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

/** PUT /api/connectors/google/:kind/config , POST /api/connectors/google/:kind/sync */
export const ConnectorKindParam = z.object({ kind: z.string().min(1) });
export const ConfigureKindBody = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().optional(),
  /** Gmail/Calendar coverage window (#68). */
  coverageWindow: CoverageWindowSchema.optional(),
  /** Gmail content mode (#68); "rich" is an explicit, privacy-affecting opt-in. */
  contentMode: GmailContentModeSchema.optional(),
  /** Calendar: the calendar ids to sync (#68). */
  enabledCalendars: z.array(z.string()).optional(),
  /** Index-only vs index+wiki for this kind (the "one of two" enable choice). */
  mode: IndexModeSchema.optional(),
  /** Gmail: label ids/names to INCLUDE — only matching messages are indexed (#88). */
  includeLabels: z.array(z.string()).optional(),
  /** Gmail: label ids/names to EXCLUDE — matching messages are skipped (#88). */
  excludeLabels: z.array(z.string()).optional(),
  /** Tasks: task-list ids to sync (#88). Empty ⇒ all lists. */
  enabledTaskLists: z.array(z.string()).optional(),
  /**
   * Full re-import (#88): clear the cursor + backfill state and trigger a fresh
   * sync, so the whole coverage window is re-pulled from scratch.
   */
  reset: z.boolean().optional(),
});

/** POST /api/connectors/google/:kind/sync */
export const SyncKindResponse = z.object({ syncing: z.boolean() });

/** GET /api/connectors/google/calendars — the available calendars to pick (#68). */
export const ListCalendarsResponse = z.object({
  calendars: z.array(CalendarListEntrySchema),
});

/** DELETE /api/connectors/google */
export const DisconnectResponse = z.object({ disconnected: z.boolean() });

// --- Google Tasks (read + write) ---

/** GET /api/connectors/google/tasks/lists */
export const TaskListsResponse = z.object({ lists: z.array(TaskListSchema) });

/** One created/synced task returned to the client. */
export const TaskSchema = z.object({
  externalId: z.string(),
  title: z.string(),
  notes: z.string().optional(),
  due: z.string().nullable().optional(),
  status: z.enum(["needsAction", "completed"]),
  completed: z.boolean(),
  taskListId: z.string(),
  taskListTitle: z.string(),
  deepLink: z.string(),
});

/** POST /api/connectors/google/tasks/create — the explicit WRITE path. */
export const CreateTaskBody = z.object({
  /** Target list; omit to use the account's default (first) list. */
  taskListId: z.string().optional(),
  title: z.string().min(1),
  notes: z.string().optional(),
  /** ISO date/time for the due date, when set. */
  due: z.string().optional(),
});

export const CreateTaskResponse = z.object({ task: TaskSchema });

export type IndexMode = z.infer<typeof IndexModeSchema>;
export type CoverageState = z.infer<typeof CoverageStateSchema>;
export type ConnectorKind = z.infer<typeof ConnectorKindSchema>;
export type ConnectorKindStatus = z.infer<typeof ConnectorKindStatusSchema>;
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;
export type ConnectorCoverage = z.infer<typeof ConnectorCoverageSchema>;
export type CalendarListEntry = z.infer<typeof CalendarListEntrySchema>;
export type CoverageWindow = z.infer<typeof CoverageWindowSchema>;
export type GmailContentMode = z.infer<typeof GmailContentModeSchema>;
export type TaskList = z.infer<typeof TaskListSchema>;
export type Task = z.infer<typeof TaskSchema>;
