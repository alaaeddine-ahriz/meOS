import { z } from "zod";

export const ConnectorKindSchema = z.enum(["contacts", "calendar", "gmail", "tasks"]);

export const ConnectorKindStatusSchema = z.object({
  kind: ConnectorKindSchema,
  enabled: z.boolean(),
  intervalMinutes: z.number(),
  lastSyncedAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
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
});

/** POST /api/connectors/google/:kind/sync */
export const SyncKindResponse = z.object({ syncing: z.boolean() });

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
export type TaskList = z.infer<typeof TaskListSchema>;
export type Task = z.infer<typeof TaskSchema>;
