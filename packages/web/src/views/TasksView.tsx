import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  type AgentTask,
  type AgentTaskRun,
  type CodingAgentSummary,
  type Schedule,
  type ScheduleKind,
  type TaskRunStatus,
} from "../api.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

/** A UTC SQLite timestamp ("YYYY-MM-DD HH:MM:SS") rendered in the user's locale. */
function formatLocal(sqlite: string | null): string {
  if (!sqlite) return "—";
  const date = new Date(`${sqlite.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/** A human-readable summary of a task's schedule. */
function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "once") return `Once · ${formatLocal(toSqlite(schedule.value))}`;
  if (schedule.kind === "interval") {
    const minutes = Number(schedule.value);
    if (minutes % 1440 === 0) return `Every ${minutes / 1440} day(s)`;
    if (minutes % 60 === 0) return `Every ${minutes / 60} hour(s)`;
    return `Every ${minutes} min`;
  }
  return `Cron · ${schedule.value}`;
}

/** Best-effort conversion of an ISO string to the SQLite shape used by formatLocal. */
function toSqlite(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 19).replace("T", " ");
}

const STATUS_STYLE: Record<TaskRunStatus, string> = {
  running: "border-lamp/30 bg-lamp/10 text-lamp",
  ok: "border-moss/30 bg-moss/10 text-moss",
  empty: "border-line bg-card text-dim",
  error: "border-ember/30 bg-ember/10 text-ember",
};

function StatusBadge({ status }: { status: TaskRunStatus }) {
  return (
    <Badge variant="outline" className={`font-mono text-[11px] ${STATUS_STYLE[status]}`}>
      {status}
    </Badge>
  );
}

export function TasksView() {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [agents, setAgents] = useState<CodingAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    api
      .listAgentTasks()
      .then((r) => setTasks(r.tasks))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));

  useEffect(() => {
    void refresh();
    api
      .listCodingAgents()
      .then((r) => setAgents(r.agents))
      .catch(() => {});
  }, []);

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl text-paper">
            <CalendarClock className="size-5 opacity-70" />
            Agent Tasks
          </h1>
          <p className="mt-1 text-sm text-dim">
            Saved instructions a coding agent runs on a schedule — once, on an interval, or by cron.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setCreating((c) => !c)}
          className="gap-1.5 bg-lamp text-desk hover:bg-lamp/90"
        >
          <Plus className="size-4" /> New task
        </Button>
      </header>

      {error && (
        <p className="mt-4 rounded-md border border-ember/30 bg-ember/5 px-3 py-2 text-sm text-ember">
          {error}
        </p>
      )}

      {creating && (
        <div className="mt-5">
          <TaskForm
            agents={agents}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              void refresh();
            }}
            onError={setError}
          />
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3">
        {loading ? (
          <p className="text-sm text-dim">Loading…</p>
        ) : tasks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-sm text-dim">
            No tasks yet. Create one to have an agent run on a schedule.
          </p>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              agents={agents}
              onChanged={refresh}
              onError={setError}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  agents,
  onChanged,
  onError,
}: {
  task: AgentTask;
  agents: CodingAgentSummary[];
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [runs, setRuns] = useState<AgentTaskRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const loadRuns = () =>
    api
      .listAgentTaskRuns(task.id)
      .then((r) => setRuns(r.runs))
      .catch((e) => onError(e instanceof Error ? e.message : String(e)));

  const toggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && runs === null) void loadRuns();
  };

  if (editing) {
    return (
      <div className="rounded-lg border border-line bg-card/40 p-4">
        <TaskForm
          task={task}
          agents={agents}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void onChanged();
          }}
          onError={onError}
        />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-card/40">
      <div className="flex items-start gap-3 p-4">
        <button
          onClick={toggleExpand}
          className="mt-0.5 text-dim hover:text-paper"
          aria-label="Toggle runs"
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-paper">{task.title}</span>
            {task.lastStatus && <StatusBadge status={task.lastStatus} />}
            {!task.enabled && (
              <Badge variant="outline" className="border-line bg-card text-[11px] text-dim">
                paused
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[13px] text-faded">{task.prompt}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-dim">
            <span>{describeSchedule(task.schedule)}</span>
            <span>{task.agentId ?? "default agent"}</span>
            <span>next: {task.enabled ? formatLocal(task.nextRunAt) : "paused"}</span>
            <span>last: {formatLocal(task.lastRunAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={task.enabled}
            disabled={busy}
            onCheckedChange={(enabled) =>
              guard(async () => {
                await api.updateAgentTask(task.id, { enabled });
                await onChanged();
              })
            }
            aria-label="Enabled"
          />
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            title="Run now"
            onClick={() =>
              guard(async () => {
                await api.runAgentTask(task.id);
                setExpanded(true);
                // Give the run a beat to register, then refresh its history.
                setTimeout(() => void loadRuns(), 400);
                await onChanged();
              })
            }
            className="text-faded hover:text-paper"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            title="Edit"
            onClick={() => setEditing(true)}
            className="text-faded hover:text-paper"
          >
            <CalendarClock className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            title="Delete"
            onClick={() =>
              guard(async () => {
                await api.deleteAgentTask(task.id);
                await onChanged();
              })
            }
            className="text-faded hover:text-ember"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-line px-4 py-3">
          {runs === null ? (
            <p className="text-[13px] text-dim">Loading runs…</p>
          ) : runs.length === 0 ? (
            <p className="text-[13px] text-dim">No runs yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {runs.map((run) => (
                <li key={run.id} className="flex items-center gap-3 font-mono text-[11px] text-dim">
                  <StatusBadge status={run.status} />
                  <span className="text-faded">{formatLocal(toSqlite(run.startedAt))}</span>
                  {run.numTurns != null && <span>{run.numTurns} turns</span>}
                  {run.durationMs != null && <span>{(run.durationMs / 1000).toFixed(1)}s</span>}
                  {run.costUsd != null && run.costUsd > 0 && <span>${run.costUsd.toFixed(3)}</span>}
                  {run.fileCount != null && run.fileCount > 0 && <span>{run.fileCount} files</span>}
                  {run.error && <span className="truncate text-ember">{run.error}</span>}
                  {task.conversationId && (
                    <button
                      onClick={() => navigate(`/?c=${task.conversationId}`)}
                      className="ml-auto text-lamp hover:underline"
                    >
                      open
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function TaskForm({
  task,
  agents,
  onCancel,
  onSaved,
  onError,
}: {
  task?: AgentTask;
  agents: CodingAgentSummary[];
  onCancel: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [agentId, setAgentId] = useState(
    task?.agentId ?? agents.find((a) => a.installed)?.id ?? "",
  );
  const [kind, setKind] = useState<ScheduleKind>(task?.schedule.kind ?? "interval");
  const [intervalMin, setIntervalMin] = useState(
    task?.schedule.kind === "interval" ? task.schedule.value : "60",
  );
  const [cronExpr, setCronExpr] = useState(
    task?.schedule.kind === "cron" ? task.schedule.value : "0 9 * * *",
  );
  const [onceAt, setOnceAt] = useState(""); // datetime-local; empty on edit (re-pick)
  const [saving, setSaving] = useState(false);

  const buildSchedule = (): Schedule => {
    if (kind === "interval") return { kind, value: String(Number(intervalMin)) };
    if (kind === "cron") return { kind, value: cronExpr.trim() };
    return { kind: "once", value: onceAt ? new Date(onceAt).toISOString() : "" };
  };

  const submit = async () => {
    if (!title.trim() || !prompt.trim()) {
      onError("Title and prompt are required.");
      return;
    }
    setSaving(true);
    try {
      const schedule = buildSchedule();
      if (task) {
        await api.updateAgentTask(task.id, {
          title: title.trim(),
          prompt: prompt.trim(),
          agentId: agentId || null,
          schedule,
        });
      } else {
        await api.createAgentTask({
          title: title.trim(),
          prompt: prompt.trim(),
          agentId: agentId || undefined,
          schedule,
        });
      }
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const installed = agents.filter((a) => a.installed);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-desk/60 p-4">
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title (e.g. Daily change brief)"
        className="border-line bg-card text-paper"
      />
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="What should the agent do each run?"
        rows={3}
        className="border-line bg-card text-paper"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger className="w-40 border-line bg-card text-paper">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            {installed.length === 0 ? (
              <SelectItem value="claude">Claude Code</SelectItem>
            ) : (
              installed.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.label}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>

        <Select value={kind} onValueChange={(v) => setKind(v as ScheduleKind)}>
          <SelectTrigger className="w-40 border-line bg-card text-paper">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="interval">Every N minutes</SelectItem>
            <SelectItem value="cron">Cron expression</SelectItem>
            <SelectItem value="once">Once, at a time</SelectItem>
          </SelectContent>
        </Select>

        {kind === "interval" && (
          <Input
            type="number"
            min={1}
            value={intervalMin}
            onChange={(e) => setIntervalMin(e.target.value)}
            className="w-28 border-line bg-card text-paper"
            placeholder="minutes"
          />
        )}
        {kind === "cron" && (
          <Input
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
            className="w-44 border-line bg-card font-mono text-paper"
            placeholder="0 9 * * *"
          />
        )}
        {kind === "once" && (
          <Input
            type="datetime-local"
            value={onceAt}
            onChange={(e) => setOnceAt(e.target.value)}
            className="w-52 border-line bg-card text-paper"
          />
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          className="text-faded hover:text-paper"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={submit}
          disabled={saving}
          className="gap-1.5 bg-lamp text-desk hover:bg-lamp/90"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          {task ? "Save" : "Create task"}
        </Button>
      </div>
    </div>
  );
}
