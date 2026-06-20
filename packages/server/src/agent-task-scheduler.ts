import { Cron } from "croner";
import { connectorLinkLabels, createLogger, type AgentTaskRecord } from "@meos/core";
import type { Schedule } from "@meos/contracts";
import { type AgentRunOutcome, runCodingAgent } from "./coding-agent-command.js";
import type { AppContext } from "./context.js";

const log = createLogger("agent-tasks");

/**
 * Scheduled agent tasks (roadmap #7). A task is a saved instruction run by one of
 * the user's coding agents on a schedule. This module owns the scheduling math
 * (when a task next runs) and the runner (executing a due task as an ordinary
 * agent turn in the task's own conversation, then logging the run + rescheduling).
 *
 * It runs in the HTTP-serving process (single-process "all" or the UI "app" role),
 * so the periodic tick and the "run now" route share one in-memory in-flight guard
 * — a task never double-runs, which matters because runs resume the same CLI
 * session. The heavy work is in the spawned CLI child, so the poll itself is cheap.
 */

/** A `datetime('now')`-format timestamp (UTC, second precision) for SQLite. */
export function toSqliteTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** Bounds for an `interval` schedule, in minutes — at least 1, at most a year. */
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 525_600;

/**
 * Validate a schedule's `value` for its `kind`, throwing a human-facing message
 * the route turns into a 400. `once` is an ISO timestamp, `interval` a minute
 * count, `cron` a croner expression.
 */
export function validateSchedule(schedule: Schedule): void {
  if (schedule.kind === "once") {
    const at = new Date(schedule.value);
    if (Number.isNaN(at.getTime())) {
      throw new Error("A 'once' schedule needs a valid date/time.");
    }
    return;
  }
  if (schedule.kind === "interval") {
    const minutes = Number(schedule.value);
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL || minutes > MAX_INTERVAL) {
      throw new Error(
        `An 'interval' schedule needs a whole number of minutes (${MIN_INTERVAL}–${MAX_INTERVAL}).`,
      );
    }
    return;
  }
  // cron: croner throws on an invalid pattern; build one (no handler → no timer)
  // just to validate, then dispose of it.
  try {
    new Cron(schedule.value).stop();
  } catch {
    throw new Error("A 'cron' schedule needs a valid cron expression.");
  }
}

/**
 * The next time a task should run strictly after `from`, in SQLite time, or null
 * when it has no future run. Used both to seed `next_run_at` at creation (from =
 * now) and to advance it after a run — `once` naturally returns null once its
 * single moment has passed, so the same call disables it.
 */
export function computeNextRunAfter(schedule: Schedule, from: Date): string | null {
  if (schedule.kind === "once") {
    const at = new Date(schedule.value);
    if (Number.isNaN(at.getTime()) || at.getTime() <= from.getTime()) return null;
    return toSqliteTime(at);
  }
  if (schedule.kind === "interval") {
    const minutes = Number(schedule.value);
    if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL) return null;
    return toSqliteTime(new Date(from.getTime() + minutes * 60_000));
  }
  let next: Date | null = null;
  try {
    const cron = new Cron(schedule.value);
    next = cron.nextRun(from);
    cron.stop();
  } catch {
    return null;
  }
  return next ? toSqliteTime(next) : null;
}

/**
 * Derive a task's cadence from its instruction text — the same lazy, deterministic
 * read as the connector detection, so the user writes "every hour, check my Gmail…"
 * and the schedule falls out of the sentence (no separate trigger form). Recognises
 * "every N minutes/hours/days", "hourly/daily/nightly/weekly/weekday", and an
 * optional "at 9[:30][am|pm]" clock; anything unstated defaults to a daily 9 AM run.
 */
export function detectSchedule(text: string): { schedule: Schedule; label: string } {
  const t = (text ?? "").toLowerCase();

  // "every 30 minutes", "every 2 hours", "every 3 days" — an explicit interval.
  const everyN = t.match(/every\s+(\d+)\s*(minute|min|hour|hr|day)s?\b/);
  if (everyN) {
    const n = Math.max(1, Number(everyN[1]));
    const unit = everyN[2]!;
    const minutes = unit.startsWith("day") ? n * 1440 : unit.startsWith("h") ? n * 60 : n;
    return {
      schedule: { kind: "interval", value: String(minutes) },
      label: intervalLabel(minutes),
    };
  }
  if (/\bevery\s+minute\b/.test(t)) {
    return { schedule: { kind: "interval", value: "1" }, label: "every minute" };
  }
  if (/\bevery\s+hour\b|\bhourly\b/.test(t)) {
    return { schedule: { kind: "interval", value: "60" }, label: "every hour" };
  }

  // A clock time mentioned anywhere ("at 9am", "at 18:30") pins the hour of a
  // day-grained cadence; absent one, daily cadences default to 9 AM.
  const hour = parseHour(t) ?? 9;
  if (/\bevery\s+weekday\b|\bon\s+weekdays\b|\bweekdays\b/.test(t)) {
    return {
      schedule: { kind: "cron", value: `0 ${hour} * * 1-5` },
      label: `every weekday at ${clockLabel(hour)}`,
    };
  }
  if (/\bweekly\b|\bevery\s+week\b/.test(t)) {
    return {
      schedule: { kind: "cron", value: `0 ${hour} * * 1` },
      label: `every Monday at ${clockLabel(hour)}`,
    };
  }
  if (/\bnightly\b|\bevery\s+night\b|\bevery\s+evening\b/.test(t)) {
    const h = parseHour(t) ?? 21;
    return {
      schedule: { kind: "cron", value: `0 ${h} * * *` },
      label: `every day at ${clockLabel(h)}`,
    };
  }
  // daily / every day / each morning / "at 9am" on its own — and the default.
  return {
    schedule: { kind: "cron", value: `0 ${hour} * * *` },
    label: `every day at ${clockLabel(hour)}`,
  };
}

/** Pull an "at 9", "at 9:30am", "at 18:00" clock hour (0–23) out of `text`, if any. */
function parseHour(text: string): number | null {
  const m = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;
  let h = Number(m[1]);
  if (h > 23) return null;
  const mer = m[3];
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  return h;
}

/** "9 AM" / "12 PM" / "6:30 PM"-style label for a 0–23 hour. */
function clockLabel(hour: number): string {
  const mer = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${mer}`;
}

/** "every 30 minutes" / "every hour" / "every 2 hours" / "every day" for a minute count. */
function intervalLabel(minutes: number): string {
  if (minutes === 1) return "every minute";
  if (minutes < 60) return `every ${minutes} minutes`;
  if (minutes === 60) return "every hour";
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "every day" : `every ${days} days`;
  }
  if (minutes % 60 === 0) return `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

/** Map an agent run's outcome onto a task-run status (`aborted` → `error`). */
function runStatus(outcome: AgentRunOutcome): "ok" | "empty" | "error" {
  return outcome.status === "aborted" ? "error" : outcome.status;
}

/**
 * The prompt a run actually sends: the task's instruction, prefixed with a one-line
 * note naming the connectors it's linked to so the agent reaches for those
 * meos-connectors tools first (it already has access to all of them; this just
 * makes the user's intended data sources explicit). Unlinked tasks run verbatim.
 */
export function buildRunPrompt(task: AgentTaskRecord): string {
  const labels = connectorLinkLabels(task.links).map((l) => l.label);
  if (labels.length === 0) return task.prompt;
  const sources = labels.join(", ");
  return (
    `This task reads from your connected ${sources} ` +
    `(use the meos-connectors tools for them).\n\n${task.prompt}`
  );
}

/** How a task's agent turn is executed — injectable so tests don't spawn a CLI. */
export type ExecuteAgent = (
  ctx: AppContext,
  conversationId: number,
  prompt: string,
  model: string | undefined,
  agentId: string | undefined,
) => Promise<AgentRunOutcome>;

/**
 * The real executor: a headless agent turn whose frames are fanned out on the
 * conversation run bus (so the Tasks view can watch it live) and persisted on the
 * message exactly as an interactive turn. `start`/`done` bracket the frames so a
 * watcher knows when to open the in-flight turn and when to refetch the result.
 */
const defaultExecute: ExecuteAgent = (ctx, conversationId, prompt, model, agentId) => {
  const send = (frame: object) => ctx.runStream.publish(conversationId, frame);
  send({ type: "start", conversationId });
  return runCodingAgent(ctx, conversationId, prompt, send, undefined, model, agentId).finally(() =>
    send({ type: "done" }),
  );
};

/**
 * Runs scheduled tasks. `tick()` (called each minute by the Cron) starts every due
 * task that isn't already running; `runNow()` starts one on demand. Each run
 * executes the task's prompt as an agent turn in the task's conversation (created
 * lazily, then resumed so recurring runs build on each other), records the outcome
 * in `agent_task_runs`, and — for scheduled runs — advances `next_run_at`.
 */
export class AgentTaskRunner {
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly execute: ExecuteAgent = defaultExecute,
  ) {}

  /** True while a run for this task is executing — used to prevent double-runs. */
  isRunning(taskId: number): boolean {
    return this.inFlight.has(taskId);
  }

  /**
   * Start a run for `task` unless one is already in flight. Returns the new run id,
   * or null if the task was already running. `reschedule` advances the task's
   * `next_run_at` when true (scheduled ticks) and leaves it untouched when false
   * (a manual "run now" shouldn't shift the schedule).
   */
  start(task: AgentTaskRecord, reschedule: boolean): number | null {
    if (this.inFlight.has(task.id)) return null;
    this.inFlight.add(task.id);
    // The conversation persists across a task's runs so a recurring task resumes
    // its own session (e.g. a daily brief that remembers yesterday). Pin it on the
    // task immediately on the first run so the Tasks view can open and live-watch
    // it right away (not only after the run finishes).
    const conversationId = task.conversationId ?? this.ctx.store.createConversation(task.title);
    if (task.conversationId == null) {
      this.ctx.store.setAgentTaskConversation(task.id, conversationId);
    }
    const runId = this.ctx.store.startAgentTaskRun(task.id);
    void this.execute(
      this.ctx,
      conversationId,
      buildRunPrompt(task),
      task.model ?? undefined,
      task.agentId ?? undefined,
    )
      .catch(
        (err): AgentRunOutcome => ({
          status: "error",
          messageId: null,
          failure: err instanceof Error ? err.message : String(err),
          telemetry: null,
          fileCount: 0,
        }),
      )
      .then((outcome) => {
        const status = runStatus(outcome);
        this.ctx.store.finishAgentTaskRun(runId, {
          status,
          messageId: outcome.messageId,
          costUsd: outcome.telemetry?.costUsd ?? null,
          numTurns: outcome.telemetry?.numTurns ?? null,
          durationMs: outcome.telemetry?.durationMs ?? null,
          fileCount: outcome.fileCount,
          error: outcome.failure,
        });
        const now = new Date();
        this.ctx.store.setAgentTaskRunState(task.id, {
          lastRunAt: toSqliteTime(now),
          lastStatus: status,
          // Manual runs preserve the schedule; scheduled runs advance it.
          nextRunAt: reschedule ? computeNextRunAfter(task.schedule, now) : task.nextRunAt,
          conversationId,
        });
        log.info({ taskId: task.id, runId, status }, "agent task run finished");
      })
      .catch((err) => log.error({ err, taskId: task.id, runId }, "failed to record task run"))
      .finally(() => this.inFlight.delete(task.id));
    return runId;
  }

  /** Start every due task not already running. Errors are logged, never thrown. */
  tick(): void {
    let due: AgentTaskRecord[];
    try {
      due = this.ctx.store.dueAgentTasks(toSqliteTime(new Date()));
    } catch (err) {
      log.error({ err }, "failed to query due agent tasks");
      return;
    }
    for (const task of due) this.start(task, true);
  }

  /** Run a task immediately by id; returns the run id, or null if already running. */
  runNow(taskId: number): number | null {
    const task = this.ctx.store.getAgentTask(taskId);
    if (!task) return null;
    return this.start(task, false);
  }
}

/** Poll for due tasks every minute. Returns the Cron so the caller can stop it. */
export function startAgentTaskScheduler(ctx: AppContext): Cron {
  const runner = ctx.agentTasks;
  if (!runner) throw new Error("ctx.agentTasks not initialised");
  return new Cron("* * * * *", () => runner.tick());
}
