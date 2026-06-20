import { agentTasks as schema } from "@meos/contracts";
import { detectConnectorLinks, listAgents } from "@meos/core";
import type { FastifyInstance } from "fastify";
import { computeNextRunAfter, detectSchedule, validateSchedule } from "../agent-task-scheduler.js";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["agent-tasks"];

/** A short task name from the first line of the instruction, when none was given. */
function deriveTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0] ?? "";
  const words = firstLine.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return (words || "Untitled task").slice(0, 80);
}

/**
 * Scheduled agent tasks (#7): CRUD over saved instructions that a coding agent
 * runs on a schedule, plus "run now" and a per-task run history. The scheduling
 * math lives in {@link computeNextRunAfter}; the actual execution is owned by
 * {@link AppContext.agentTasks} (the runner), shared with the per-minute poller so
 * a task never double-runs. Routes only validate input and (re)seed `next_run_at`.
 */
export function registerAgentTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Reject an unknown agent id early (a typo would otherwise silently fall back). */
  const assertKnownAgent = (agentId: string | null | undefined) => {
    if (agentId == null) return;
    if (!listAgents().some((a) => a.id === agentId)) {
      throw httpError.validation(`Unknown agent '${agentId}'`);
    }
  };

  app.get(
    "/api/agent-tasks",
    {
      schema: routeSchema({
        tags,
        summary: "List scheduled agent tasks",
        response: schema.AgentTasksResponse,
      }),
    },
    async () => schema.AgentTasksResponse.parse({ tasks: ctx.store.listAgentTasks() }),
  );

  // Live connector detection for the workflow composer: the UI posts the in-progress
  // instruction (debounced) and renders the connectors the agent will read from,
  // before the task is ever saved. Pure + cheap (deterministic phrase matching over
  // the connector registry), so it's safe to call on every keystroke.
  app.post(
    "/api/agent-tasks/analyze",
    {
      schema: routeSchema({
        tags,
        summary: "Detect the connectors referenced by an instruction",
        body: schema.AnalyzeAgentTaskBody,
        response: schema.AnalyzeAgentTaskResponse,
      }),
    },
    async (request) => {
      const body = parseOrThrow(schema.AnalyzeAgentTaskBody, request.body, "body");
      const { schedule, label } = detectSchedule(body.prompt);
      return schema.AnalyzeAgentTaskResponse.parse({
        connectors: detectConnectorLinks(body.prompt),
        schedule,
        scheduleLabel: label,
      });
    },
  );

  app.post(
    "/api/agent-tasks",
    {
      schema: routeSchema({
        tags,
        summary: "Create a scheduled agent task",
        body: schema.CreateAgentTaskBody,
        response: { 201: schema.AgentTaskResponse },
      }),
    },
    async (request, reply) => {
      const body = parseOrThrow(schema.CreateAgentTaskBody, request.body, "body");
      assertKnownAgent(body.agentId);
      // The cadence falls out of the instruction text ("every hour, …") unless the
      // caller passed an explicit schedule (raw API use).
      const schedule = body.schedule ?? detectSchedule(body.prompt).schedule;
      try {
        validateSchedule(schedule);
      } catch (error) {
        throw httpError.validation(error instanceof Error ? error.message : "Invalid schedule");
      }
      const enabled = body.enabled ?? true;
      // Seed the first run from now; a paused task has no due time until enabled.
      const nextRunAt = enabled ? computeNextRunAfter(schedule, new Date()) : null;
      // The UI sends the resolved links it showed the user; when omitted (e.g. a raw
      // API call) auto-identify the connectors from the instruction so the data
      // sources are always explicit. Drop the per-match metadata before storing.
      const links =
        body.links ??
        detectConnectorLinks(body.prompt).map((l) => ({ provider: l.provider, kind: l.kind }));
      const task = ctx.store.createAgentTask({
        title: body.title ?? deriveTitle(body.prompt),
        prompt: body.prompt,
        agentId: body.agentId ?? null,
        model: body.model ?? null,
        scheduleKind: schedule.kind,
        scheduleValue: schedule.value,
        links,
        enabled,
        nextRunAt,
      });
      return reply.code(201).send(schema.AgentTaskResponse.parse({ task }));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/agent-tasks/:id",
    {
      schema: routeSchema({
        tags,
        summary: "Get a task with its recent runs",
        params: schema.AgentTaskIdParam,
        response: schema.AgentTaskDetailResponse,
      }),
    },
    async (request) => {
      const { id } = parseOrThrow(schema.AgentTaskIdParam, request.params, "params");
      const task = ctx.store.getAgentTask(id);
      if (!task) throw httpError.notFound("No such task");
      return schema.AgentTaskDetailResponse.parse({
        task,
        runs: ctx.store.listAgentTaskRuns(id),
      });
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/agent-tasks/:id",
    {
      schema: routeSchema({
        tags,
        summary: "Update a scheduled agent task",
        params: schema.AgentTaskIdParam,
        body: schema.UpdateAgentTaskBody,
        response: schema.AgentTaskResponse,
      }),
    },
    async (request) => {
      const { id } = parseOrThrow(schema.AgentTaskIdParam, request.params, "params");
      const body = parseOrThrow(schema.UpdateAgentTaskBody, request.body, "body");
      const existing = ctx.store.getAgentTask(id);
      if (!existing) throw httpError.notFound("No such task");
      if (body.agentId !== undefined) assertKnownAgent(body.agentId);

      // Editing the instruction re-derives the cadence + data sources from the new
      // text (the composer is text-only), unless the caller passed them explicitly.
      const promptChanged = body.prompt !== undefined && body.prompt !== existing.prompt;
      const schedule =
        body.schedule ?? (promptChanged ? detectSchedule(body.prompt!).schedule : undefined);
      const links =
        body.links ??
        (promptChanged
          ? detectConnectorLinks(body.prompt!).map((l) => ({ provider: l.provider, kind: l.kind }))
          : undefined);
      if (schedule) {
        try {
          validateSchedule(schedule);
        } catch (error) {
          throw httpError.validation(error instanceof Error ? error.message : "Invalid schedule");
        }
      }
      // Re-seed next_run_at when the cadence or enabled state changes — editing only
      // the title shouldn't reset the timer.
      const enabled = body.enabled ?? existing.enabled;
      const rescheduled = schedule !== undefined || body.enabled !== undefined;
      const nextRunAt = rescheduled
        ? enabled
          ? computeNextRunAfter(schedule ?? existing.schedule, new Date())
          : null
        : undefined;
      const task = ctx.store.updateAgentTask(id, {
        title: body.title,
        prompt: body.prompt,
        agentId: body.agentId,
        model: body.model,
        scheduleKind: schedule?.kind,
        scheduleValue: schedule?.value,
        links,
        enabled: body.enabled,
        nextRunAt,
      });
      return schema.AgentTaskResponse.parse({ task });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/agent-tasks/:id",
    {
      schema: routeSchema({
        tags,
        summary: "Delete a scheduled agent task",
        params: schema.AgentTaskIdParam,
        response: schema.DeleteAgentTaskResponse,
      }),
    },
    async (request) => {
      const { id } = parseOrThrow(schema.AgentTaskIdParam, request.params, "params");
      return schema.DeleteAgentTaskResponse.parse({ ok: ctx.store.deleteAgentTask(id) });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/agent-tasks/:id/run",
    {
      schema: routeSchema({
        tags,
        summary: "Run a task now",
        params: schema.AgentTaskIdParam,
        response: { 202: schema.RunAgentTaskResponse },
      }),
    },
    async (request, reply) => {
      const { id } = parseOrThrow(schema.AgentTaskIdParam, request.params, "params");
      const task = ctx.store.getAgentTask(id);
      if (!task) throw httpError.notFound("No such task");
      const runner = ctx.agentTasks;
      if (!runner) throw httpError.internal("Task runner unavailable");
      const runId = runner.start(task, false);
      if (runId === null) throw httpError.conflict("This task is already running");
      // start() pins the conversation on the task before returning, so the client
      // can open it and watch this run stream in live.
      const conversationId = ctx.store.getAgentTask(id)?.conversationId ?? task.conversationId;
      if (conversationId == null) throw httpError.internal("Run started without a conversation");
      return reply.code(202).send(schema.RunAgentTaskResponse.parse({ runId, conversationId }));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/agent-tasks/:id/runs",
    {
      schema: routeSchema({
        tags,
        summary: "List a task's runs",
        params: schema.AgentTaskIdParam,
        response: schema.AgentTaskRunsResponse,
      }),
    },
    async (request) => {
      const { id } = parseOrThrow(schema.AgentTaskIdParam, request.params, "params");
      if (!ctx.store.getAgentTask(id)) throw httpError.notFound("No such task");
      return schema.AgentTaskRunsResponse.parse({ runs: ctx.store.listAgentTaskRuns(id) });
    },
  );
}
