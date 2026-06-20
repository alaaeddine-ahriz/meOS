import {
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { createElement, Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  type AgentTask,
  type AgentTaskRun,
  type CodingAgentSummary,
  type DetectedConnector,
  type Schedule,
  type ScheduleKind,
  type TaskConnectorLink,
  type TaskRunStatus,
} from "../api.js";
import { brandLogo } from "@/components/brand-logos";
import { useConnectorCatalog, type ConnectorCatalogApi } from "../hooks/use-connector-catalog.js";
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
import {
  buildWorkflowConnectors,
  TaskWorkflow,
  type WorkflowConnector,
} from "./tasks/TaskWorkflow.js";

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

/** The trigger node's label + sub for a schedule, e.g. {"Every hour", "on the :00"}. */
function triggerSummary(schedule: Schedule): { label: string; sub: string } {
  if (schedule.kind === "once") {
    return { label: "Once", sub: formatLocal(toSqlite(schedule.value)) };
  }
  if (schedule.kind === "cron") return { label: "On schedule", sub: schedule.value };
  const min = Number(schedule.value);
  if (!Number.isFinite(min)) return { label: "On a timer", sub: "repeats" };
  if (min === 60) return { label: "Every hour", sub: "on the :00" };
  if (min === 1440) return { label: "Every day", sub: "daily" };
  if (min % 1440 === 0) return { label: `Every ${min / 1440} days`, sub: "repeats" };
  if (min % 60 === 0) return { label: `Every ${min / 60} hours`, sub: "repeats" };
  return { label: `Every ${min} min`, sub: "repeats" };
}

/** The agent's display label, falling back to its id or "Claude". */
function agentLabel(agentId: string | null, agents: CodingAgentSummary[]): string {
  if (!agentId) return agents.find((a) => a.installed)?.label ?? "Claude";
  return agents.find((a) => a.id === agentId)?.label ?? agentId;
}

/** A short task name derived from the instruction when the user didn't name it. */
function deriveTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0] ?? "";
  const words = firstLine.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  return (words || "Untitled task").slice(0, 80);
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

/**
 * Render a connector's brand mark from its catalog `logo` id. brandLogo resolves
 * to a stable component from the module-level LOGO_REGISTRY; `createElement` keeps
 * the dynamic lookup out of JSX so it reads as a runtime selection, not a
 * component defined per render.
 */
function BrandIcon({ logo, className }: { logo?: string; className?: string }) {
  return createElement(brandLogo(logo), { className });
}

/** One connector's highlight spec: the phrases to chip-wrap + its brand. */
interface HighlightSpec {
  provider: string;
  kind: string;
  brandColor?: string;
  logo?: string;
  phrases: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Render an instruction with every linked-connector phrase wrapped in a small
 * branded chip (logo + word), so the prose visibly shows which connectors the
 * agent will touch — the editable-workflow read of the same text.
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
    // Longest phrases first so "google tasks" wins over "tasks".
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
      provider: link.provider,
      kind: link.kind,
      brandColor: connector.brandColor,
      logo: kind.logo,
      phrases: [kind.displayName, kind.noun.one, kind.noun.many],
    });
  }
  return specs;
}

// ── view ─────────────────────────────────────────────────────────────────────

export function TasksView() {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [agents, setAgents] = useState<CodingAgentSummary[]>([]);
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const catalog = useConnectorCatalog();

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
    api
      .getConnectors()
      .then((r) =>
        setConnected(new Set(r.providers.filter((p) => p.connected).map((p) => p.provider))),
      )
      .catch(() => {});
  }, []);

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-6 py-10">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl text-paper">
            <Workflow className="size-5 opacity-70" />
            Agent Tasks
          </h1>
          <p className="mt-1 max-w-xl text-sm text-dim">
            Describe what you want in plain language — the agent auto-detects the connectors it
            needs and runs the workflow on a schedule.
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
            agents={agents}
            catalog={catalog}
            connected={connected}
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
            No tasks yet. Click <span className="text-paper">New task</span> and describe what the
            agent should do.
          </p>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              agents={agents}
              catalog={catalog}
              connected={connected}
              onChanged={refresh}
              onError={setError}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── task card (display) ───────────────────────────────────────────────────────

function TaskCard({
  task,
  agents,
  catalog,
  connected,
  onChanged,
  onError,
}: {
  task: AgentTask;
  agents: CodingAgentSummary[];
  catalog: ConnectorCatalogApi;
  connected: Set<string>;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
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

  // Load the run history once so the footer can show the last run's telemetry.
  useEffect(() => {
    void loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.lastRunAt]);

  const connectors: WorkflowConnector[] = useMemo(
    () => buildWorkflowConnectors(task.links, catalog, connected),
    [task.links, catalog, connected],
  );
  const specs = useMemo(() => specsForLinks(task.links, catalog), [task.links, catalog]);
  const lastRun = runs?.[0] ?? null;

  if (editing) {
    return (
      <div className="rounded-xl border border-line bg-card/40 p-4">
        <TaskComposer
          task={task}
          agents={agents}
          catalog={catalog}
          connected={connected}
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
    <div className="rounded-xl border border-line bg-card/40">
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
            aria-label="Active"
          />
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            title="Run now"
            onClick={() =>
              guard(async () => {
                await api.runAgentTask(task.id);
                setShowHistory(true);
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

      {/* detected-connectors banner */}
      {task.links.length > 0 && (
        <div className="mx-5 mt-3 flex items-center gap-2 rounded-lg border border-line/70 bg-desk/40 px-3 py-2 text-[12px] text-faded">
          <Sparkles className="size-3.5 shrink-0 text-lamp" />
          <span>
            <span className="font-medium text-paper">
              {task.links.length} connector{task.links.length === 1 ? "" : "s"}
            </span>{" "}
            linked — the agent reads from each on every run.
          </span>
          <button
            onClick={() => setEditing(true)}
            className="ml-auto shrink-0 font-mono text-[11px] text-dim hover:text-paper"
          >
            edit links
          </button>
        </div>
      )}

      {/* workflow graph */}
      <div className="px-5 py-3">
        <TaskWorkflow
          trigger={triggerSummary(task.schedule)}
          connectors={connectors}
          agent={{ label: agentLabel(task.agentId, agents), sub: "reasons & writes" }}
          delivers={{ label: "Recap", sub: "to Chat" }}
          active={task.enabled}
        />
      </div>

      {/* footer: last run summary */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-5 py-2.5 font-mono text-[11px] text-dim">
        {task.lastStatus ? <StatusBadge status={task.lastStatus} /> : <span>no runs yet</span>}
        {task.lastRunAt && (
          <span className="text-faded">Last run {formatLocal(task.lastRunAt)}</span>
        )}
        {lastRun?.durationMs != null && <span>{(lastRun.durationMs / 1000).toFixed(1)}s</span>}
        {lastRun?.costUsd != null && lastRun.costUsd > 0 && (
          <span>${lastRun.costUsd.toFixed(3)}</span>
        )}
        {task.conversationId != null && task.lastRunAt && (
          <button
            onClick={() => navigate(`/?c=${task.conversationId}`)}
            className="text-lamp hover:underline"
          >
            View recap →
          </button>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Clock className="size-3" />
          {task.enabled ? (
            <>
              next {relativeFromNow(task.nextRunAt)} · {formatLocal(task.nextRunAt)}
            </>
          ) : (
            "paused"
          )}
        </span>
      </div>

      {/* run history disclosure */}
      <div className="border-t border-line px-5">
        <button
          onClick={() => setShowHistory((s) => !s)}
          className="flex items-center gap-1 py-2 text-[11px] text-dim hover:text-paper"
        >
          {showHistory ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          History
        </button>
        {showHistory && (
          <div className="pb-3">
            {runs === null ? (
              <p className="text-[12px] text-dim">Loading runs…</p>
            ) : runs.length === 0 ? (
              <p className="text-[12px] text-dim">No runs yet.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {runs.map((run) => (
                  <li
                    key={run.id}
                    className="flex items-center gap-3 font-mono text-[11px] text-dim"
                  >
                    <StatusBadge status={run.status} />
                    <span className="text-faded">{formatLocal(toSqlite(run.startedAt))}</span>
                    {run.numTurns != null && <span>{run.numTurns} turns</span>}
                    {run.durationMs != null && <span>{(run.durationMs / 1000).toFixed(1)}s</span>}
                    {run.costUsd != null && run.costUsd > 0 && (
                      <span>${run.costUsd.toFixed(3)}</span>
                    )}
                    {run.error && <span className="truncate text-ember">{run.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── composer (create / edit) ──────────────────────────────────────────────────

function TaskComposer({
  task,
  agents,
  catalog,
  connected,
  onCancel,
  onSaved,
  onError,
}: {
  task?: AgentTask;
  agents: CodingAgentSummary[];
  catalog: ConnectorCatalogApi;
  connected: Set<string>;
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
  const [onceAt, setOnceAt] = useState("");
  const [saving, setSaving] = useState(false);

  const [links, setLinks] = useState<TaskConnectorLink[]>(task?.links ?? []);
  // In edit mode the saved links are authoritative; in create mode the links
  // follow detection until the user touches them.
  const [linksTouched, setLinksTouched] = useState(Boolean(task));
  const [detected, setDetected] = useState<DetectedConnector[]>([]);

  // Debounced live detection: as the instruction changes, ask the server which
  // connectors it references and (when untouched) adopt them automatically. All
  // state updates live inside the debounced callback so the effect body never
  // sets state synchronously.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (!prompt.trim()) {
        setDetected([]);
        if (!linksTouched) setLinks([]);
        return;
      }
      api
        .analyzeAgentTask(prompt)
        .then((r) => {
          setDetected(r.connectors);
          setLinks((prev) =>
            linksTouched ? prev : r.connectors.map((c) => ({ provider: c.provider, kind: c.kind })),
          );
        })
        .catch(() => {});
    }, 300);
    return () => clearTimeout(handle);
  }, [prompt, linksTouched]);

  const linkKey = (l: TaskConnectorLink) => `${l.provider}:${l.kind}`;
  const linkedSet = new Set(links.map(linkKey));

  const addLink = (link: TaskConnectorLink) => {
    setLinksTouched(true);
    setLinks((prev) => (prev.some((l) => linkKey(l) === linkKey(link)) ? prev : [...prev, link]));
  };
  const removeLink = (link: TaskConnectorLink) => {
    setLinksTouched(true);
    setLinks((prev) => prev.filter((l) => linkKey(l) !== linkKey(link)));
  };

  // Detected connectors not yet linked — one-click suggestions.
  const suggestions = detected.filter((d) => !linkedSet.has(`${d.provider}:${d.kind}`));
  // Every catalog kind, for the manual "add a source" picker.
  const allKinds = catalog.connectors.flatMap((c) =>
    c.kinds.map((k) => ({
      provider: c.id,
      kind: k.kind,
      label: `${c.displayName} · ${k.displayName}`,
    })),
  );
  const addable = allKinds.filter((k) => !linkedSet.has(`${k.provider}:${k.kind}`));

  const workflowConnectors = useMemo(
    () => buildWorkflowConnectors(links, catalog, connected),
    [links, catalog, connected],
  );

  // Precise highlight: use the phrases the analyzer actually matched, falling back
  // to catalog display names for links the user added manually.
  const highlightSpecs: HighlightSpec[] = links.map((link) => {
    const connector = catalog.connector(link.provider);
    const k = connector?.kinds.find((kk) => kk.kind === link.kind);
    const det = detected.find((d) => d.provider === link.provider && d.kind === link.kind);
    const phrases = det?.matches.length
      ? det.matches
      : k
        ? [k.displayName, k.noun.one, k.noun.many]
        : [];
    return {
      provider: link.provider,
      kind: link.kind,
      brandColor: connector?.brandColor,
      logo: k?.logo,
      phrases,
    };
  });

  const buildSchedule = (): Schedule => {
    if (kind === "interval") return { kind, value: String(Number(intervalMin)) };
    if (kind === "cron") return { kind, value: cronExpr.trim() };
    return { kind: "once", value: onceAt ? new Date(onceAt).toISOString() : "" };
  };

  const submit = async () => {
    if (!prompt.trim()) {
      onError("Describe what the agent should do.");
      return;
    }
    setSaving(true);
    try {
      const schedule = buildSchedule();
      const finalTitle = title.trim() || deriveTitle(prompt);
      if (task) {
        await api.updateAgentTask(task.id, {
          title: finalTitle,
          prompt: prompt.trim(),
          agentId: agentId || null,
          schedule,
          links,
        });
      } else {
        await api.createAgentTask({
          title: finalTitle,
          prompt: prompt.trim(),
          agentId: agentId || undefined,
          schedule,
          links,
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
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-desk/50 p-4">
      {/* the instruction — the natural-language heart of the task */}
      <div>
        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-dim">
          Instruction
        </label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Every hour, look through my Gmail for messages that need a reply and check my Calendar for anything coming up — then tell me what needs my attention."
          rows={3}
          className="border-line bg-card text-paper"
          autoFocus
        />
        {prompt.trim() && highlightSpecs.some((s) => s.phrases.length > 0) && (
          <p className="mt-2 text-[12px] leading-relaxed text-faded">
            <HighlightedInstruction text={prompt} specs={highlightSpecs} />
          </p>
        )}
      </div>

      {/* auto-detected connectors */}
      <div className="rounded-lg border border-line/70 bg-card/50 px-3 py-2.5">
        <div className="flex items-center gap-2 text-[12px]">
          <Sparkles className="size-3.5 text-lamp" />
          {links.length > 0 ? (
            <span className="text-faded">
              <span className="font-medium text-paper">
                {links.length} connector{links.length === 1 ? "" : "s"}
              </span>{" "}
              {linksTouched ? "linked" : "detected & linked automatically"}
            </span>
          ) : (
            <span className="text-dim">
              No connectors detected yet — mention Gmail, Calendar, Contacts… or add one below.
            </span>
          )}
        </div>

        {/* linked chips */}
        {links.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {links.map((link) => {
              const connector = catalog.connector(link.provider);
              const k = connector?.kinds.find((kk) => kk.kind === link.kind);
              return (
                <span
                  key={linkKey(link)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line py-1 pl-2 pr-1 text-[12px] text-paper"
                  style={{ backgroundColor: tintColor(connector?.brandColor) }}
                >
                  <BrandIcon logo={k?.logo} className="size-3.5" />
                  {k?.displayName ?? link.kind}
                  <button
                    onClick={() => removeLink(link)}
                    className="ml-0.5 rounded-full p-0.5 text-dim hover:bg-ink/10 hover:text-ember"
                    aria-label={`Remove ${k?.displayName ?? link.kind}`}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {/* suggestions + manual add */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {suggestions.map((s) => {
            const connector = catalog.connector(s.provider);
            const k = connector?.kinds.find((kk) => kk.kind === s.kind);
            return (
              <button
                key={`${s.provider}:${s.kind}`}
                onClick={() => addLink({ provider: s.provider, kind: s.kind })}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2 py-1 text-[11px] text-faded hover:border-lamp hover:text-paper"
              >
                <BrandIcon logo={k?.logo} className="size-3" />+ {k?.displayName ?? s.kind}
              </button>
            );
          })}
          {addable.length > 0 && (
            <Select
              value=""
              onValueChange={(v) => {
                const [provider, kindId] = v.split(":");
                if (provider && kindId) addLink({ provider, kind: kindId });
              }}
            >
              <SelectTrigger className="h-7 w-auto gap-1 border-dashed border-line bg-transparent px-2 text-[11px] text-dim">
                <Plus className="size-3" /> Add source
              </SelectTrigger>
              <SelectContent>
                {addable.map((k) => (
                  <SelectItem key={`${k.provider}:${k.kind}`} value={`${k.provider}:${k.kind}`}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* live workflow preview */}
      {prompt.trim() && (
        <div className="rounded-lg border border-line/70 bg-card/30 px-3 py-2">
          <TaskWorkflow
            trigger={triggerSummary(buildSchedule())}
            connectors={workflowConnectors}
            agent={{ label: agentLabel(agentId || null, agents), sub: "reasons & writes" }}
            delivers={{ label: "Recap", sub: "to Chat" }}
            active
          />
        </div>
      )}

      {/* name + trigger + agent */}
      <div className="flex flex-col gap-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={`Name (optional) — defaults to “${deriveTitle(prompt || "…")}”`}
          className="border-line bg-card text-paper"
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-dim">Trigger</span>
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

          <span className="ml-2 text-[11px] font-medium uppercase tracking-wide text-dim">
            Agent
          </span>
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
        </div>
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
          {task ? "Save changes" : "Create task"}
        </Button>
      </div>
    </div>
  );
}
