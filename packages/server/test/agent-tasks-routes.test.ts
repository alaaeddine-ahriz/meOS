import { agentTasks } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentTaskRunner } from "../src/agent-task-scheduler.js";
import type { AgentRunOutcome } from "../src/coding-agent-command.js";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

const createBody = {
  title: "Daily brief",
  prompt: "Summarise what changed today.",
  agentId: "claude",
  schedule: { kind: "cron", value: "0 9 * * *" },
};

describe("agent task routes (#7)", () => {
  it("creates, lists, fetches, updates, and deletes a task", async () => {
    const created = await server.app.inject({
      method: "POST",
      url: "/api/agent-tasks",
      payload: createBody,
    });
    expect(created.statusCode).toBe(201);
    const { task } = agentTasks.AgentTaskResponse.parse(created.json());
    expect(task).toMatchObject({
      title: "Daily brief",
      agentId: "claude",
      schedule: { kind: "cron", value: "0 9 * * *" },
      enabled: true,
    });
    // An enabled cron task is seeded with a future next run.
    expect(task.nextRunAt).not.toBeNull();

    const list = await server.app.inject({ method: "GET", url: "/api/agent-tasks" });
    expect(agentTasks.AgentTasksResponse.parse(list.json()).tasks.map((t) => t.id)).toContain(
      task.id,
    );

    const detail = await server.app.inject({ method: "GET", url: `/api/agent-tasks/${task.id}` });
    const parsedDetail = agentTasks.AgentTaskDetailResponse.parse(detail.json());
    expect(parsedDetail.task.id).toBe(task.id);
    expect(parsedDetail.runs).toEqual([]);

    // Pausing clears the next run; editing the title alone must not.
    const paused = await server.app.inject({
      method: "PATCH",
      url: `/api/agent-tasks/${task.id}`,
      payload: { enabled: false },
    });
    expect(agentTasks.AgentTaskResponse.parse(paused.json()).task.nextRunAt).toBeNull();
    const renamed = await server.app.inject({
      method: "PATCH",
      url: `/api/agent-tasks/${task.id}`,
      payload: { title: "Renamed" },
    });
    const renamedTask = agentTasks.AgentTaskResponse.parse(renamed.json()).task;
    expect(renamedTask.title).toBe("Renamed");
    expect(renamedTask.nextRunAt).toBeNull(); // still paused, schedule untouched

    const del = await server.app.inject({ method: "DELETE", url: `/api/agent-tasks/${task.id}` });
    expect(agentTasks.DeleteAgentTaskResponse.parse(del.json()).ok).toBe(true);
    const gone = await server.app.inject({ method: "GET", url: `/api/agent-tasks/${task.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it("analyzes an instruction and auto-links the detected connectors on create", async () => {
    const analyze = await server.app.inject({
      method: "POST",
      url: "/api/agent-tasks/analyze",
      payload: { prompt: "Check my Gmail for replies and my Calendar for conflicts." },
    });
    expect(analyze.statusCode).toBe(200);
    const detected = agentTasks.AnalyzeAgentTaskResponse.parse(analyze.json()).connectors;
    expect(detected.map((c) => `${c.provider}:${c.kind}`)).toEqual(
      expect.arrayContaining(["google:gmail", "google:calendar"]),
    );

    // Creating without explicit links seeds them from the prompt.
    const created = await server.app.inject({
      method: "POST",
      url: "/api/agent-tasks",
      payload: {
        ...createBody,
        prompt: "Check my Gmail for replies and my Calendar for conflicts.",
      },
    });
    const { task } = agentTasks.AgentTaskResponse.parse(created.json());
    expect(task.links).toEqual(
      expect.arrayContaining([
        { provider: "google", kind: "gmail" },
        { provider: "google", kind: "calendar" },
      ]),
    );

    // An explicit edit replaces the set.
    const edited = await server.app.inject({
      method: "PATCH",
      url: `/api/agent-tasks/${task.id}`,
      payload: { links: [{ provider: "google", kind: "tasks" }] },
    });
    expect(agentTasks.AgentTaskResponse.parse(edited.json()).task.links).toEqual([
      { provider: "google", kind: "tasks" },
    ]);
  });

  it("rejects an invalid schedule and an unknown agent with 400", async () => {
    const badCron = await server.app.inject({
      method: "POST",
      url: "/api/agent-tasks",
      payload: { ...createBody, schedule: { kind: "cron", value: "definitely not cron" } },
    });
    expect(badCron.statusCode).toBe(400);

    const badAgent = await server.app.inject({
      method: "POST",
      url: "/api/agent-tasks",
      payload: { ...createBody, agentId: "nonesuch" },
    });
    expect(badAgent.statusCode).toBe(400);
  });

  it("runs a task now through the injected runner and logs the run", async () => {
    // Swap in a runner whose executor is faked, so run-now doesn't spawn a CLI.
    const outcome: AgentRunOutcome = {
      status: "ok",
      messageId: null,
      failure: null,
      telemetry: { costUsd: 0.02, numTurns: 1, durationMs: 500 },
      fileCount: 0,
    };
    server.ctx.agentTasks = new AgentTaskRunner(server.ctx, () => Promise.resolve(outcome));

    const created = await server.app.inject({
      method: "POST",
      url: "/api/agent-tasks",
      payload: { ...createBody, schedule: { kind: "interval", value: "60" } },
    });
    const { task } = agentTasks.AgentTaskResponse.parse(created.json());

    const run = await server.app.inject({ method: "POST", url: `/api/agent-tasks/${task.id}/run` });
    expect(run.statusCode).toBe(202);
    expect(agentTasks.RunAgentTaskResponse.parse(run.json()).runId).toBeGreaterThan(0);

    // The run completes asynchronously; poll the runs endpoint until it lands.
    let runs: ReturnType<typeof agentTasks.AgentTaskRunsResponse.parse>["runs"] = [];
    for (let i = 0; i < 100 && (runs.length === 0 || runs[0]?.status === "running"); i++) {
      const res = await server.app.inject({
        method: "GET",
        url: `/api/agent-tasks/${task.id}/runs`,
      });
      runs = agentTasks.AgentTaskRunsResponse.parse(res.json()).runs;
      if (runs[0]?.status === "ok") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runs[0]).toMatchObject({ status: "ok", numTurns: 1, durationMs: 500 });

    const detail = await server.app.inject({ method: "GET", url: `/api/agent-tasks/${task.id}` });
    expect(agentTasks.AgentTaskDetailResponse.parse(detail.json()).task.lastStatus).toBe("ok");
  });

  it("404s running a missing task", async () => {
    const res = await server.app.inject({ method: "POST", url: "/api/agent-tasks/99999/run" });
    expect(res.statusCode).toBe(404);
  });
});
