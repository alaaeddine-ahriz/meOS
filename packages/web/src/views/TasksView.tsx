import {
  CalendarClock,
  ChevronRight,
  Clock,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { createElement, Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  api,
  type AgentTask,
  type AgentTaskRun,
  type Schedule,
  type TaskConnectorLink,
  type TaskRunStatus,
} from "../api.js";
import { brandLogo } from "@/components/brand-logos";
import { useConnectorCatalog, type ConnectorCatalogApi } from "../hooks/use-connector-catalog.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ChatView } from "./ChatView.js";

// ── small formatters ────────────────────────────────────────────────────────

/** A UTC SQLite timestamp ("YYYY-MM-DD HH:MM:SS") rendered in the user's locale. */
function formatLocal(sqlite: string | null): string {
  if (!sqlite) return "—";
  const date = new Date(`${sqlite.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/** Best-effort conversion of an ISO string to the SQLite shape used by formatLocal. */
function toSqlite(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 19).replace("T", " ");
}

/** A coarse "in 47 min" / "in 2 hr" relative time for a future SQLite timestamp. */
function relativeFromNow(sqlite: string | null): string {
  if (!sqlite) return "—";
  const date = new Date(`${sqlite.replace(" ", "T")}Z`);
  const diffMs = date.getTime() - Date.now();
  if (Number.isNaN(diffMs)) return "—";
  if (diffMs <= 0) return "due now";
  const min = Math.round(diffMs / 60_000);
  if (min < 60) return `in ${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `in ${hr} hr`;
  return `in ${Math.round(hr / 24)} days`;
}

/** "9 AM" / "6:30 PM"-style label for an hour field (and optional minute). */
function clock(hour: number, minute = 0): string {
  const mer = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute ? `${h12}:${String(minute).padStart(2, "0")} ${mer}` : `${h12} ${mer}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * A short human label for a schedule — mirrors how the server reads cadence out of
 * the instruction, so the card reads the same way the user wrote it ("every hour",
 * "every day at 9 AM"). Falls back to the raw cron expression for anything exotic.
 */
function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "once") return `once · ${formatLocal(toSqlite(schedule.value))}`;
  if (schedule.kind === "interval") {
    const min = Number(schedule.value);
    if (!Number.isFinite(min)) return "on a timer";
    if (min === 1) return "every minute";
    if (min < 60) return `every ${min} minutes`;
    if (min === 60) return "every hour";
    if (min % 1440 === 0) return min === 1440 ? "every day" : `every ${min / 1440} days`;
    if (min % 60 === 0) return `every ${min / 60} hours`;
    return `every ${min} minutes`;
  }
  // cron — recognise the shapes detectSchedule emits; otherwise show it verbatim.
  const m = schedule.value.trim().match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+(\*|\d+(?:-\d+)?)$/);
  if (!m) return schedule.value;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  const dow = m[3]!;
  const at = `at ${clock(hour, minute)}`;
  if (dow === "*") return `every day ${at}`;
  if (dow === "1-5") return `every weekday ${at}`;
  if (/^\d+$/.test(dow)) return `every ${WEEKDAYS[Number(dow) % 7]} ${at}`;
  return `${schedule.value}`;
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

// ── highlighting the instruction with its linked connectors ──────────────────

/** A 14%-opacity tint of a hex brand color for a chip backdrop. */
function tintColor(hex: string | undefined): string | undefined {
  return hex ? `color-mix(in srgb, ${hex} 14%, transparent)` : "var(--color-desk)";
}

/** Render a connector's brand mark from its catalog `logo` id. */
function BrandIcon({ logo, className }: { logo?: string; className?: string }) {
  return createElement(brandLogo(logo), { className });
}

/** One connector's highlight spec: the phrases to chip-wrap + its brand. */
interface HighlightSpec {
  brandColor?: string;
  logo?: string;
  phrases: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Render an instruction with every linked-connector phrase wrapped in a small
 * branded chip (logo + word), so the prose itself shows which connectors the agent
 * will touch — the whole task surface is the text, lightly annotated.
 */
function HighlightedInstruction({ text, specs }: { text: string; specs: HighlightSpec[] }) {
  const { regex, lookup } = useMemo(() => {
    const phraseToSpec = new Map<string, HighlightSpec>();
    const all: string[] = [];
    for (const spec of specs) {
      for (const p of spec.phrases) {
        const key = p.toLowerCase();
        if (!phraseToSpec.has(key)) {
          phraseToSpec.set(key, spec);
          all.push(p);
        }
      }
    }
    if (all.length === 0) return { regex: null as RegExp | null, lookup: phraseToSpec };
    all.sort((a, b) => b.length - a.length);
    return {
      regex: new RegExp(`\\b(${all.map(escapeRegExp).join("|")})\\b`, "gi"),
      lookup: phraseToSpec,
    };
  }, [specs]);

  if (!regex) return <>{text}</>;

  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(regex)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(<Fragment key={key++}>{text.slice(last, idx)}</Fragment>);
    const word = m[0];
    const spec = lookup.get(word.toLowerCase());
    out.push(
      <span
        key={key++}
        className="mx-0.5 inline-flex items-center gap-1 rounded px-1 py-px align-baseline text-[0.95em] font-medium text-paper"
        style={{ backgroundColor: tintColor(spec?.brandColor) }}
      >
        <BrandIcon logo={spec?.logo} className="size-3" />
        {word}
      </span>,
    );
    last = idx + word.length;
  }
  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}

/** Highlight specs for a task's links, deriving phrases from the catalog. */
function specsForLinks(links: TaskConnectorLink[], catalog: ConnectorCatalogApi): HighlightSpec[] {
  const specs: HighlightSpec[] = [];
  for (const link of links) {
    const connector = catalog.connector(link.provider);
    const kind = connector?.kinds.find((k) => k.kind === link.kind);
    if (!connector || !kind) continue;
    specs.push({
      brandColor: connector.brandColor,
      logo: kind.logo,
      phrases: [kind.displayName, kind.noun.one, kind.noun.many],
    });
  }
  return specs;
}

// ── view ─────────────────────────────────────────────────────────────────────

/** The conversation a run streams into, plus the task it belongs to (for the title). */
interface Selection {
  taskId: number;
  conversationId: number;
}

export function TasksView() {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const catalog = useConnectorCatalog();

  const refresh = () =>
    api
      .listAgentTasks()
      .then((r) => setTasks(r.tasks))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));

  useEffect(() => {
    void refresh();
  }, []);

  const selectedTask = selected ? tasks.find((t) => t.id === selected.taskId) : null;

  return (
    <div className="flex h-full min-w-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col px-6 py-10">
          <header className="flex items-start justify-between">
            <div>
              <h1 className="flex items-center gap-2 font-serif text-2xl text-paper">
                <CalendarClock className="size-5 opacity-70" />
                Agent Tasks
              </h1>
              <p className="mt-1 max-w-xl text-sm text-dim">
                Describe what you want in plain language — including how often. The agent figures
                out the schedule and the connectors it needs, then runs on its own.
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
              <TaskComposer
                catalog={catalog}
                onCancel={() => setCreating(false)}
                onSaved={() => {
                  setCreating(false);
                  void refresh();
                }}
                onError={setError}
              />
            </div>
          )}

          <div className="mt-6 flex flex-col gap-4">
            {loading ? (
              <p className="text-sm text-dim">Loading…</p>
            ) : tasks.length === 0 && !creating ? (
              <p className="rounded-lg border border-dashed border-line px-4 py-12 text-center text-sm text-dim">
                No tasks yet. Click <span className="text-paper">New task</span> and describe what
                the agent should do.
              </p>
            ) : (
              tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  catalog={catalog}
                  active={selected?.taskId === task.id}
                  onOpen={(conversationId) => setSelected({ taskId: task.id, conversationId })}
                  onChanged={refresh}
                  onError={setError}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {selected && (
        <aside className="flex h-full w-[460px] shrink-0 flex-col border-l border-line bg-desk">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Play className="size-3.5 shrink-0 text-lamp" />
            <span className="truncate text-sm font-medium text-paper">
              {selectedTask?.title ?? "Run"}
            </span>
            <button
              onClick={() => setSelected(null)}
              className="ml-auto rounded p-1 text-dim hover:bg-card hover:text-paper"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <ChatView
              key={selected.conversationId}
              conversationId={selected.conversationId}
              embedded
            />
          </div>
        </aside>
      )}
    </div>
  );
}

// ── task card (display) ───────────────────────────────────────────────────────

function TaskCard({
  task,
  catalog,
  active,
  onOpen,
  onChanged,
  onError,
}: {
  task: AgentTask;
  catalog: ConnectorCatalogApi;
  active: boolean;
  onOpen: (conversationId: number) => void;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [runs, setRuns] = useState<AgentTaskRun[] | null>(null);
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    void loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.lastRunAt]);

  const specs = useMemo(() => specsForLinks(task.links, catalog), [task.links, catalog]);
  const lastRun = runs?.[0] ?? null;
  const isRunning = lastRun?.status === "running";

  if (editing) {
    return (
      <div className="rounded-xl border border-line bg-card/40 p-4">
        <TaskComposer
          task={task}
          catalog={catalog}
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

  const openConversation = () => {
    if (task.conversationId != null) onOpen(task.conversationId);
  };

  return (
    <div className={`rounded-xl border bg-card/40 ${active ? "border-lamp/50" : "border-line"}`}>
      {/* header */}
      <div className="flex items-start gap-3 px-5 pt-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-paper">{task.title}</span>
            <Badge
              variant="outline"
              className={
                task.enabled
                  ? "border-moss/30 bg-moss/10 text-[11px] text-moss"
                  : "border-line bg-card text-[11px] text-dim"
              }
            >
              {task.enabled ? "active" : "paused"}
            </Badge>
            {isRunning && (
              <span className="inline-flex items-center gap-1 text-[11px] text-lamp">
                <Loader2 className="size-3 animate-spin" /> running
              </span>
            )}
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-faded">
            <HighlightedInstruction text={task.prompt} specs={specs} />
          </p>
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
            aria-label={task.enabled ? "Pause task" : "Resume task"}
          />
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            title="Run now"
            onClick={() =>
              guard(async () => {
                const { conversationId } = await api.runAgentTask(task.id);
                onOpen(conversationId);
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
            <Pencil className="size-4" />
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

      {/* meta: cadence + next run */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pb-1 pt-3 text-[12px] text-dim">
        <span className="inline-flex items-center gap-1.5 text-faded">
          <Clock className="size-3.5 opacity-70" />
          {describeSchedule(task.schedule)}
        </span>
        <span className="text-line">·</span>
        <span>{task.enabled ? <>next {relativeFromNow(task.nextRunAt)}</> : "paused"}</span>
      </div>

      {/* run history — each row opens the conversation on the right to watch it work */}
      <div className="mt-2 border-t border-line px-5 py-2">
        {runs === null ? (
          <p className="text-[12px] text-dim">Loading runs…</p>
        ) : runs.length === 0 ? (
          <p className="text-[12px] text-dim">No runs yet — hit play to run it now.</p>
        ) : (
          <ul className="flex flex-col">
            {runs.slice(0, 6).map((run) => (
              <li key={run.id}>
                <button
                  onClick={openConversation}
                  disabled={task.conversationId == null}
                  className="flex w-full items-center gap-3 rounded-md px-1 py-1.5 text-left font-mono text-[11px] text-dim hover:bg-card/60 disabled:cursor-default disabled:hover:bg-transparent"
                  title="Open this run in the chat panel"
                >
                  <StatusBadge status={run.status} />
                  <span className="text-faded">{formatLocal(toSqlite(run.startedAt))}</span>
                  {run.numTurns != null && <span>{run.numTurns} turns</span>}
                  {run.durationMs != null && <span>{(run.durationMs / 1000).toFixed(1)}s</span>}
                  {run.costUsd != null && run.costUsd > 0 && <span>${run.costUsd.toFixed(3)}</span>}
                  {run.error && <span className="truncate text-ember">{run.error}</span>}
                  {task.conversationId != null && (
                    <ChevronRight className="ml-auto size-3.5 shrink-0 opacity-60" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── composer (create / edit) ──────────────────────────────────────────────────

function TaskComposer({
  task,
  catalog,
  onCancel,
  onSaved,
  onError,
}: {
  task?: AgentTask;
  catalog: ConnectorCatalogApi;
  onCancel: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [saving, setSaving] = useState(false);
  // What the platform read out of the instruction: the connectors it references
  // and the cadence it expresses — both derived live as the user types.
  const [links, setLinks] = useState<TaskConnectorLink[]>(task?.links ?? []);
  const [scheduleLabel, setScheduleLabel] = useState<string>(
    task ? describeSchedule(task.schedule) : "",
  );

  useEffect(() => {
    const handle = setTimeout(() => {
      if (!prompt.trim()) {
        setLinks([]);
        setScheduleLabel("");
        return;
      }
      api
        .analyzeAgentTask(prompt)
        .then((r) => {
          setLinks(r.connectors.map((c) => ({ provider: c.provider, kind: c.kind })));
          setScheduleLabel(r.scheduleLabel);
        })
        .catch(() => {});
    }, 300);
    return () => clearTimeout(handle);
  }, [prompt]);

  const highlightSpecs = useMemo(() => specsForLinks(links, catalog), [links, catalog]);

  const submit = async () => {
    if (!prompt.trim()) {
      onError("Describe what the agent should do.");
      return;
    }
    setSaving(true);
    try {
      // The schedule, title, and connectors all derive from the instruction text
      // server-side, so the client just sends the prompt.
      if (task) {
        await api.updateAgentTask(task.id, { prompt: prompt.trim() });
      } else {
        await api.createAgentTask({ prompt: prompt.trim() });
      }
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-desk/50 p-4">
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="e.g. Every morning at 8, look through my Gmail for messages that need a reply and check my Calendar for what's coming up — then tell me what needs my attention."
        rows={4}
        className="border-line bg-card text-paper"
        autoFocus
      />

      {/* the same text, with the connectors the agent will touch highlighted */}
      {prompt.trim() && highlightSpecs.length > 0 && (
        <p className="text-[12px] leading-relaxed text-faded">
          <HighlightedInstruction text={prompt} specs={highlightSpecs} />
        </p>
      )}

      {/* the cadence read out of the sentence */}
      {prompt.trim() && (
        <div className="flex items-center gap-1.5 text-[12px] text-dim">
          <Clock className="size-3.5 text-lamp" />
          Runs{" "}
          <span className="font-medium text-paper">{scheduleLabel || "every day at 9 AM"}</span>
          <span className="text-dim/70">— change the wording to change the schedule</span>
        </div>
      )}

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
          {task ? "Save changes" : "Create task"}
        </Button>
      </div>
    </div>
  );
}
