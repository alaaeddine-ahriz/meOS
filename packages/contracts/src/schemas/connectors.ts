import { z } from "zod";

export const ConnectorKindSchema = z.enum(["contacts", "calendar", "gmail", "tasks"]);

/** How far back a kind indexes (#68). "recent" is the safe default seed. */
export const CoverageWindowSchema = z.enum(["recent", "30d", "90d", "1y", "all"]);

/** Gmail content depth (#68): metadata-only (default, private) vs richer opt-in. */
export const GmailContentModeSchema = z.enum(["metadata", "rich"]);

/** Resumable Gmail backfill progress, surfaced so partial coverage is obvious (#68). */
export const GmailBackfillProgressSchema = z.object({
  /** Items indexed by the historical backfill so far. */
  indexed: z.number(),
  /** Oldest indexed message date (ISO), or null. */
  oldestIndexed: z.string().nullable(),
  /** True once the backfill has covered the whole window. */
  complete: z.boolean(),
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
  // --- gmail ---
  contentMode: GmailContentModeSchema.optional(),
  backfill: GmailBackfillProgressSchema.optional(),
  // --- calendar ---
  availableCalendars: z.array(CalendarListEntrySchema).optional(),
  enabledCalendars: z.array(z.string()).optional(),
  calendars: z.array(CalendarCoverageSchema).optional(),
});

export const ConnectorKindStatusSchema = z.object({
  kind: ConnectorKindSchema,
  enabled: z.boolean(),
  intervalMinutes: z.number(),
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

/** One Google Tasks task list (selection + the create-task default list). */
export const TaskListSchema = z.object({
  id: z.string(),
  title: z.string(),
});

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

export type ConnectorKind = z.infer<typeof ConnectorKindSchema>;
export type ConnectorKindStatus = z.infer<typeof ConnectorKindStatusSchema>;
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;
export type ConnectorCoverage = z.infer<typeof ConnectorCoverageSchema>;
export type CalendarListEntry = z.infer<typeof CalendarListEntrySchema>;
export type CoverageWindow = z.infer<typeof CoverageWindowSchema>;
export type GmailContentMode = z.infer<typeof GmailContentModeSchema>;
export type TaskList = z.infer<typeof TaskListSchema>;
export type Task = z.infer<typeof TaskSchema>;
