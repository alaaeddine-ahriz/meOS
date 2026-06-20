import { z } from "zod";
import { NumericIdParam } from "./common.js";

/**
 * Scheduled agent tasks (roadmap #7). A task is a saved instruction handed to one
 * of the user's coding agents, run automatically on a schedule — once at a time,
 * every N minutes, or on a cron expression. Each task owns a conversation, so a
 * run is just another agent turn: its trace, telemetry, and file changes persist
 * through the same path as interactive agent mode, and recurring tasks resume the
 * same session so they build on prior runs (e.g. a nightly "what changed?" brief).
 */

/** How a task's next run time is derived. */
export const ScheduleKindSchema = z.enum(["once", "interval", "cron"]);

/**
 * The schedule's parameter, interpreted per kind:
 * - `once`     — an ISO timestamp to run at (then the task disables itself).
 * - `interval` — a positive integer number of minutes between runs.
 * - `cron`     — a 5/6-field cron expression (croner syntax).
 */
export const ScheduleSchema = z.object({
  kind: ScheduleKindSchema,
  value: z.string().min(1),
});

/** A task run's terminal (or in-flight) status. */
export const TaskRunStatusSchema = z.enum(["running", "ok", "empty", "error"]);

/**
 * One connector/kind a task reads from — the data sources the agent uses on every
 * run, auto-identified from the instruction text and editable in the workflow UI.
 * `provider`/`kind` match a catalog connector (e.g. `{ provider: "google", kind:
 * "gmail" }`), so the UI joins to the catalog for branding and the run names them.
 */
export const TaskConnectorLinkSchema = z.object({
  provider: z.string(),
  kind: z.string(),
});

/** A coding-agent task as stored and surfaced to the UI. */
export const AgentTaskSchema = z.object({
  id: z.number(),
  title: z.string(),
  /** The instruction handed to the agent each run. */
  prompt: z.string(),
  /** Which coding agent runs it (`claude` | `codex` | …); null = server default. */
  agentId: z.string().nullable(),
  /** Model override passed to the agent, or null for the agent's default. */
  model: z.string().nullable(),
  schedule: ScheduleSchema,
  /** The connectors this task reads from each run (auto-detected, then editable). */
  links: z.array(TaskConnectorLinkSchema),
  /** Paused tasks keep their schedule but never run until re-enabled. */
  enabled: z.boolean(),
  /** When the task next becomes due (ISO), or null once it never runs again. */
  nextRunAt: z.string().nullable(),
  /** When the task last started a run (ISO), or null if it never has. */
  lastRunAt: z.string().nullable(),
  /** The status of the most recent run, or null before the first. */
  lastStatus: TaskRunStatusSchema.nullable(),
  /** The conversation this task's runs accumulate in (null until the first run). */
  conversationId: z.number().nullable(),
  createdAt: z.string(),
});

/** One execution of a task — what it cost and how it ended. */
export const AgentTaskRunSchema = z.object({
  id: z.number(),
  taskId: z.number(),
  status: TaskRunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** The assistant message this run produced, for loading its full trace. */
  messageId: z.number().nullable(),
  costUsd: z.number().nullable(),
  numTurns: z.number().nullable(),
  durationMs: z.number().nullable(),
  /** How many files the run touched in its workspace. */
  fileCount: z.number().nullable(),
  /** A human-facing failure reason when `status` is `error`. */
  error: z.string().nullable(),
});

/** POST /api/agent-tasks — create a task. */
export const CreateAgentTaskBody = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  agentId: z.string().optional(),
  model: z.string().optional(),
  schedule: ScheduleSchema,
  /** Defaults to enabled; pass false to create it paused. */
  enabled: z.boolean().optional(),
  /** The linked connectors; omit to let the server auto-detect from the prompt. */
  links: z.array(TaskConnectorLinkSchema).optional(),
});

/** PATCH /api/agent-tasks/:id — partial update (any field). */
export const UpdateAgentTaskBody = z.object({
  title: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(20_000).optional(),
  agentId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  schedule: ScheduleSchema.optional(),
  enabled: z.boolean().optional(),
  /** Replace the linked connectors (the workflow UI sends the resolved set). */
  links: z.array(TaskConnectorLinkSchema).optional(),
});

/** POST /api/agent-tasks/analyze — body for live connector detection as you type. */
export const AnalyzeAgentTaskBody = z.object({
  prompt: z.string().max(20_000),
});

/** One connector the analyzer found in an instruction, with the phrases that hit. */
export const DetectedConnectorSchema = TaskConnectorLinkSchema.extend({
  /** The literal phrases in the prompt that triggered this link, for highlighting. */
  matches: z.array(z.string()),
});

/** POST /api/agent-tasks/analyze — the connectors detected in the prompt. */
export const AnalyzeAgentTaskResponse = z.object({
  connectors: z.array(DetectedConnectorSchema),
});

export const AgentTaskIdParam = NumericIdParam;

export const AgentTaskResponse = z.object({ task: AgentTaskSchema });
export const AgentTasksResponse = z.object({ tasks: z.array(AgentTaskSchema) });
export const AgentTaskDetailResponse = z.object({
  task: AgentTaskSchema,
  runs: z.array(AgentTaskRunSchema),
});
export const AgentTaskRunsResponse = z.object({ runs: z.array(AgentTaskRunSchema) });
/** POST /api/agent-tasks/:id/run — enqueue an immediate run. */
export const RunAgentTaskResponse = z.object({ runId: z.number() });
export const DeleteAgentTaskResponse = z.object({ ok: z.boolean() });

export type ScheduleKind = z.infer<typeof ScheduleKindSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type TaskRunStatus = z.infer<typeof TaskRunStatusSchema>;
export type TaskConnectorLink = z.infer<typeof TaskConnectorLinkSchema>;
export type AgentTask = z.infer<typeof AgentTaskSchema>;
export type AgentTaskRun = z.infer<typeof AgentTaskRunSchema>;
export type DetectedConnector = z.infer<typeof DetectedConnectorSchema>;
