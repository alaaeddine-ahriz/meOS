import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { KnowledgeStore, type NewAgentTask } from "../src/knowledge/store.js";

let store: KnowledgeStore;

beforeEach(() => {
  store = new KnowledgeStore(openDatabase(":memory:"));
});

const baseTask = (over: Partial<NewAgentTask> = {}): NewAgentTask => ({
  title: "Daily brief",
  prompt: "Summarise what changed today.",
  agentId: "claude",
  model: null,
  scheduleKind: "interval",
  scheduleValue: "60",
  enabled: true,
  nextRunAt: "2026-06-20 09:00:00",
  ...over,
});

describe("agent task store", () => {
  it("creates and reads a task in the camelCase API shape", () => {
    const task = store.createAgentTask(baseTask());
    expect(task).toMatchObject({
      title: "Daily brief",
      agentId: "claude",
      model: null,
      schedule: { kind: "interval", value: "60" },
      enabled: true,
      nextRunAt: "2026-06-20 09:00:00",
      lastRunAt: null,
      lastStatus: null,
      conversationId: null,
    });
    expect(store.getAgentTask(task.id)).toEqual(task);
    expect(store.listAgentTasks()).toEqual([task]);
  });

  it("returns only enabled, due tasks from dueAgentTasks", () => {
    const due = store.createAgentTask(baseTask({ nextRunAt: "2026-06-20 08:00:00" }));
    store.createAgentTask(baseTask({ title: "Future", nextRunAt: "2099-01-01 00:00:00" }));
    store.createAgentTask(
      baseTask({ title: "Paused", enabled: false, nextRunAt: "2026-06-20 08:00:00" }),
    );
    store.createAgentTask(baseTask({ title: "No next", nextRunAt: null }));

    const result = store.dueAgentTasks("2026-06-20 09:00:00");
    expect(result.map((t) => t.id)).toEqual([due.id]);
  });

  it("applies partial updates and clears nullable fields", () => {
    const task = store.createAgentTask(baseTask());
    const updated = store.updateAgentTask(task.id, {
      title: "Renamed",
      model: "claude-opus-4-8",
      enabled: false,
      scheduleKind: "cron",
      scheduleValue: "0 9 * * *",
    });
    expect(updated).toMatchObject({
      title: "Renamed",
      model: "claude-opus-4-8",
      enabled: false,
      schedule: { kind: "cron", value: "0 9 * * *" },
    });
    expect(store.updateAgentTask(task.id, { agentId: null })?.agentId).toBeNull();
  });

  it("records a run lifecycle and reflects it on the task", () => {
    const task = store.createAgentTask(baseTask());
    const conversationId = store.createConversation("Daily brief");
    const messageId = store.addMessage(conversationId, "assistant", "All good.");
    const runId = store.startAgentTaskRun(task.id);

    let runs = store.listAgentTaskRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "running", finishedAt: null });

    store.finishAgentTaskRun(runId, {
      status: "ok",
      messageId,
      costUsd: 0.02,
      numTurns: 3,
      durationMs: 1500,
      fileCount: 2,
    });
    store.setAgentTaskRunState(task.id, {
      lastRunAt: "2026-06-20 09:00:00",
      lastStatus: "ok",
      nextRunAt: "2026-06-20 10:00:00",
      conversationId,
    });

    runs = store.listAgentTaskRuns(task.id);
    expect(runs[0]).toMatchObject({
      status: "ok",
      messageId,
      costUsd: 0.02,
      numTurns: 3,
      durationMs: 1500,
      fileCount: 2,
    });
    expect(runs[0]?.finishedAt).not.toBeNull();
    const after = store.getAgentTask(task.id)!;
    expect(after.lastStatus).toBe("ok");
    expect(after.nextRunAt).toBe("2026-06-20 10:00:00");
    expect(after.conversationId).toBe(conversationId);
  });

  it("cascades run deletion when the task is deleted", () => {
    const task = store.createAgentTask(baseTask());
    store.startAgentTaskRun(task.id);
    expect(store.deleteAgentTask(task.id)).toBe(true);
    expect(store.getAgentTask(task.id)).toBeUndefined();
    expect(store.listAgentTaskRuns(task.id)).toEqual([]);
    expect(store.deleteAgentTask(task.id)).toBe(false);
  });
});
