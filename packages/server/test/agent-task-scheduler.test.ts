import { openDatabase, KnowledgeStore, type NewAgentTask } from "@meos/core";
import { describe, expect, it } from "vitest";
import {
  AgentTaskRunner,
  computeNextRunAfter,
  toSqliteTime,
  validateSchedule,
  type ExecuteAgent,
} from "../src/agent-task-scheduler.js";
import type { AgentRunOutcome } from "../src/coding-agent-command.js";
import type { AppContext } from "../src/context.js";

// messageId is null here: the fake executor doesn't persist a message, and the
// run's message_id FK would reject a dangling id. The store round-trip test
// covers persisting a real messageId.
const ok: AgentRunOutcome = {
  status: "ok",
  messageId: null,
  failure: null,
  telemetry: { costUsd: 0.01, numTurns: 2, durationMs: 1000 },
  fileCount: 1,
};

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const newTask = (over: Partial<NewAgentTask> = {}): NewAgentTask => ({
  title: "T",
  prompt: "do it",
  agentId: null,
  model: null,
  scheduleKind: "interval",
  scheduleValue: "60",
  enabled: true,
  nextRunAt: "2026-06-20 09:00:00",
  ...over,
});

function fixture(execute: ExecuteAgent) {
  const store = new KnowledgeStore(openDatabase(":memory:"));
  const ctx = { store } as unknown as AppContext;
  const runner = new AgentTaskRunner(ctx, execute);
  return { store, runner };
}

describe("computeNextRunAfter", () => {
  const from = new Date("2026-06-20T09:00:00Z");

  it("once returns the moment when future, null when past", () => {
    expect(computeNextRunAfter({ kind: "once", value: "2026-06-20T10:00:00Z" }, from)).toBe(
      "2026-06-20 10:00:00",
    );
    expect(computeNextRunAfter({ kind: "once", value: "2026-06-20T08:00:00Z" }, from)).toBeNull();
  });

  it("interval adds N minutes", () => {
    expect(computeNextRunAfter({ kind: "interval", value: "30" }, from)).toBe(
      "2026-06-20 09:30:00",
    );
  });

  it("cron returns the next matching time (timezone-robust)", () => {
    // croner resolves cron in the local timezone (a desktop user's own clock), so
    // assert the shape rather than a literal UTC string: a daily cron lands strictly
    // after `from` and within the next day-and-a-bit, whatever the test TZ.
    const next = computeNextRunAfter({ kind: "cron", value: "0 10 * * *" }, from);
    expect(next).not.toBeNull();
    const t = new Date(`${next!.replace(" ", "T")}Z`).getTime();
    expect(t).toBeGreaterThan(from.getTime());
    expect(t).toBeLessThanOrEqual(from.getTime() + 25 * 3600_000);
  });
});

describe("validateSchedule", () => {
  it("accepts valid schedules", () => {
    expect(() => validateSchedule({ kind: "once", value: "2026-06-20T10:00:00Z" })).not.toThrow();
    expect(() => validateSchedule({ kind: "interval", value: "15" })).not.toThrow();
    expect(() => validateSchedule({ kind: "cron", value: "0 9 * * 1-5" })).not.toThrow();
  });

  it("rejects invalid schedules", () => {
    expect(() => validateSchedule({ kind: "once", value: "not-a-date" })).toThrow();
    expect(() => validateSchedule({ kind: "interval", value: "0" })).toThrow();
    expect(() => validateSchedule({ kind: "interval", value: "1.5" })).toThrow();
    expect(() => validateSchedule({ kind: "cron", value: "nonsense ?? bad" })).toThrow();
  });
});

describe("toSqliteTime", () => {
  it("formats UTC to second precision", () => {
    expect(toSqliteTime(new Date("2026-06-20T09:00:00.500Z"))).toBe("2026-06-20 09:00:00");
  });
});

describe("AgentTaskRunner", () => {
  it("runs a due task, records the outcome, and advances next_run_at", async () => {
    const { store, runner } = fixture(() => Promise.resolve(ok));
    const task = store.createAgentTask(newTask({ nextRunAt: "2026-06-20 08:00:00" }));
    const before = Date.now();

    runner.tick();
    await until(() => store.listAgentTaskRuns(task.id)[0]?.status === "ok");

    const run = store.listAgentTaskRuns(task.id)[0]!;
    expect(run).toMatchObject({ status: "ok", numTurns: 2, fileCount: 1 });
    const after = store.getAgentTask(task.id)!;
    expect(after.lastStatus).toBe("ok");
    // A conversation was created and pinned to the task for future resumes.
    expect(after.conversationId).not.toBeNull();
    // Interval 60 → next run ~60 min ahead.
    const next = new Date(`${after.nextRunAt!.replace(" ", "T")}Z`).getTime();
    expect(next).toBeGreaterThan(before + 59 * 60_000);
  });

  it("does not double-run a task already in flight", () => {
    let resolve!: (o: AgentRunOutcome) => void;
    const pending = new Promise<AgentRunOutcome>((r) => (resolve = r));
    const { store, runner } = fixture(() => pending);
    const task = store.createAgentTask(newTask());

    expect(runner.start(task, false)).not.toBeNull();
    expect(runner.start(task, false)).toBeNull(); // guarded
    resolve(ok);
  });

  it("records a thrown execution as an error run", async () => {
    const { store, runner } = fixture(() => Promise.reject(new Error("boom")));
    const task = store.createAgentTask(newTask());
    runner.start(task, false);
    await until(() => store.listAgentTaskRuns(task.id)[0]?.status === "error");
    expect(store.listAgentTaskRuns(task.id)[0]?.error).toBe("boom");
  });

  it("run now preserves the schedule's next_run_at", async () => {
    const { store, runner } = fixture(() => Promise.resolve(ok));
    const task = store.createAgentTask(newTask({ nextRunAt: "2099-01-01 00:00:00" }));
    runner.runNow(task.id);
    await until(() => store.getAgentTask(task.id)?.lastStatus === "ok");
    expect(store.getAgentTask(task.id)?.nextRunAt).toBe("2099-01-01 00:00:00");
  });
});
