import { agentTasks as schema } from "@meos/contracts";
import { listAgents } from "@meos/core";
import type { FastifyInstance } from "fastify";
import { computeNextRunAfter, validateSchedule } from "../agent-task-scheduler.js";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["agent-tasks"];

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
      try {
        validateSchedule(body.schedule);
      } catch (error) {
        throw httpError.validation(error instanceof Error ? error.message : "Invalid schedule");
      }
      const enabled = body.enabled ?? true;
      // Seed the first run from now; a paused task has no due time until enabled.
      const nextRunAt = enabled ? computeNextRunAfter(body.schedule, new Date()) : null;
      const task = ctx.store.createAgentTask({
        title: body.title,
        prompt: body.prompt,
        agentId: body.agentId ?? null,
        model: body.model ?? null,
        scheduleKind: body.schedule.kind,
        scheduleValue: body.schedule.value,
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
      if (body.schedule) {
        try {
          validateSchedule(body.schedule);
        } catch (error) {
          throw httpError.validation(error instanceof Error ? error.message : "Invalid schedule");
        }
      }
      // Only re-seed next_run_at when the schedule or enabled state actually
      // changes — editing the title shouldn't reset the timer.
      const schedule = body.schedule ?? existing.schedule;
      const enabled = body.enabled ?? existing.enabled;
      const rescheduled = body.schedule !== undefined || body.enabled !== undefined;
      const nextRunAt = rescheduled
        ? enabled
          ? computeNextRunAfter(schedule, new Date())
          : null
        : undefined;
      const task = ctx.store.updateAgentTask(id, {
        title: body.title,
        prompt: body.prompt,
        agentId: body.agentId,
        model: body.model,
        scheduleKind: body.schedule?.kind,
        scheduleValue: body.schedule?.value,
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
      return reply.code(202).send(schema.RunAgentTaskResponse.parse({ runId }));
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
