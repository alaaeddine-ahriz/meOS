import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Cpu,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  RotateCw,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { brandLogo } from "@/components/brand-logos";
import { type SourceTypeBrand, useConnectorCatalog } from "@/hooks/use-connector-catalog";
import { cn } from "@/lib/utils";
import {
  api,
  type ConnectorHealth,
  type IngestJob,
  type IngestMetrics,
  type RuntimeHealth,
  type SourceHealth,
} from "../api.js";
import { formatRelative, formatTime } from "../lib/datetime.js";
import { explainError } from "../lib/explain-error.js";
import {
  ENGINE_META,
  engineStatus,
  parseFailure,
  stepLabel,
  workerLabel,
} from "../lib/ingest-format.js";

/**
 * The single Health section (lives at `sources?tab=health`). It folds together
 * what used to be three screens — the source-health dashboard, the ingest
 * observability panel, and the workers/process list — into one place that
 * answers, top to bottom: is everything OK? if not, what broke and at which
 * step? It leads with a one-line verdict, presents the background processing as
 * a single "engine" rather than a list of workers/processes, lists every
 * failure with the step it failed at (expand for the full error + fixes), and
 * keeps the deep telemetry tucked behind a "Technical details" disclosure.
 *
 * Composes the existing endpoints (source-health, runtime, ingest metrics +
 * jobs) and reuses the existing retry/rebuild/cancel/pause controls — it adds
 * no new backend surface.
 */

/** The three product-level health labels. */
const HEALTH: Record<string, { label: string; dot: string; Icon: LucideIcon; tone: string }> = {
  healthy: {
    label: "Healthy",
    dot: "bg-emerald-500",
    Icon: CheckCircle2,
    tone: "text-emerald-500",
  },
  degraded: {
    label: "Needs attention",
    dot: "bg-amber-500",
    Icon: AlertTriangle,
    tone: "text-amber-500",
  },
  disconnected: { label: "Not connected", dot: "bg-dim", Icon: XCircle, tone: "text-dim" },
};

/** Plain-language wording for a connector's completeness state. */
const STATE_WORDING: Record<string, string> = {
  complete: "Fully indexed",
  partial: "Partially indexed",
  "recent-only": "Recent items only",
  backfilling: "Catching up on history…",
  failed: "Last sync failed",
  idle: "Not synced yet",
};

const HEALTH_FALLBACK = { label: "Not connected", dot: "bg-dim", Icon: XCircle, tone: "text-dim" };

function HealthBadge({ health }: { health: string }) {
  const meta = HEALTH[health] ?? HEALTH_FALLBACK;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", meta.tone)}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}

/** A small labelled count; `hint` becomes a native tooltip explaining the number. */
function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string | number;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5" title={hint}>
      <span className="text-[11px] uppercase tracking-wide text-dim">{label}</span>
      <span className={cn("font-mono text-sm", tone ?? "text-paper", value === 0 && "text-dim")}>
        {value}
      </span>
    </div>
  );
}

function CountsRow({
  counts,
}: {
  counts: { indexed: number; failed: number; skipped: number; deleted: number; pending: number };
}) {
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
      <Stat label="indexed" value={counts.indexed} hint="Items meOS read and understood." />
      <Stat
        label="failed"
        value={counts.failed}
        tone={counts.failed > 0 ? "text-ember" : undefined}
        hint="Items meOS couldn't process — see Needs attention below."
      />
      <Stat
        label="skipped"
        value={counts.skipped}
        hint="Items intentionally skipped (unsupported type or unchanged)."
      />
      <Stat
        label="removed"
        value={counts.deleted}
        hint="Items removed upstream and retired locally."
      />
      <Stat label="pending" value={counts.pending} hint="Items queued and not processed yet." />
    </div>
  );
}

function ConnectorCard({ k, brand }: { k: ConnectorHealth; brand: SourceTypeBrand }) {
  // The brand (label + logo) comes from the connector catalog, resolved by the
  // parent from this kind's `<provider>:<kind>` source type.
  const Logo = brand.Logo;
  return (
    <div className="rounded-xl border border-line bg-card/40 px-4 py-3">
      <div className="mb-2 flex items-center gap-2.5">
        <Logo className="size-4 shrink-0" />
        <span className="flex-1 text-sm font-medium text-paper">{k.label || brand.label}</span>
        <HealthBadge health={k.health} />
      </div>
      <p className="mb-2 text-xs text-dim">
        {k.enabled ? (STATE_WORDING[k.state] ?? k.state) : "Turned off"}
        {k.lastSuccessAt && <> · last synced {formatRelative(k.lastSuccessAt)}</>}
      </p>
      <CountsRow counts={k.counts} />
      {k.lastError &&
        (() => {
          // Translate the raw sync error to plain English; keep the original as a
          // hover tooltip for anyone who wants the literal provider text.
          const explained = explainError(k.lastError);
          return (
            <p
              className="mt-2 flex items-start gap-1.5 text-[11px] text-ember"
              title={k.lastError ?? undefined}
            >
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span className="break-words">{explained?.title ?? k.lastError}</span>
            </p>
          );
        })()}
    </div>
  );
}

/** One failing job: collapsed it shows the step it failed at; expanded it shows
 * the full error, where, and the fixes (retry / rebuild / cancel). */
function ProblemRow({
  job,
  busy,
  onAction,
}: {
  job: IngestJob;
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const { step, message } = parseFailure(job.lastError);
  const info = stepLabel(step ?? job.stage);
  // Plain-English version of the raw error; the raw text stays in the log below.
  const explained = explainError(message);
  const dead = job.state === "dead-letter";
  return (
    <li className="overflow-hidden rounded-xl border border-line bg-desk">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-card/40"
      >
        <XCircle className="size-4 shrink-0 text-ember" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-paper">
              {job.kind} #{job.id}
            </span>
            <span
              className="shrink-0 rounded-full border border-ember/40 px-1.5 py-0.5 text-[10px] font-medium text-ember"
              title={info.blurb}
            >
              Failed while: {info.label}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-dim">
            {dead ? "gave up after retries" : "will retry"} · {job.attempts}/{job.maxAttempts} tries
            · {formatRelative(job.updatedAt)}
          </div>
          {/* A one-line, plain-English preview so the failure is legible without
              expanding (the raw error lives in the log when expanded). */}
          {!open && explained && (
            <div className="mt-1 truncate text-[11px] text-ember/90">{explained.title}</div>
          )}
        </div>
        <ChevronRight
          className={cn("size-4 shrink-0 text-dim transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-4 py-3">
          {/* Plain-English explanation + a suggested fix, ahead of the raw log. */}
          {explained && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
              <p className="text-[12px] font-medium text-paper">{explained.title}</p>
              <p className="mt-0.5 text-[12px] text-faded">{explained.detail}</p>
              {explained.fix && <p className="mt-1 text-[12px] text-amber-400">{explained.fix}</p>}
            </div>
          )}
          {info.blurb && <p className="text-[13px] text-faded">{info.blurb}</p>}
          {job.sourceId != null && (
            <p className="text-[12px] text-dim">
              <span className="text-faded">Source:</span> #{job.sourceId}
              <span className="ml-2 text-faded">Queue:</span> {job.queue}
            </p>
          )}
          <div className="space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wider text-dim">
              Error log · failed at {info.label.toLowerCase()}
            </p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-card px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-faded">
              {message || "No error was recorded."}
            </pre>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(() => api.retryIngestJob(job.id))}
              className="rounded-md border border-line px-2.5 py-1 text-[11px] text-paper hover:bg-line/40 disabled:opacity-50"
            >
              Retry
            </button>
            {job.sourceId != null && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onAction(() => api.rebuildSource(job.sourceId!))}
                className="rounded-md border border-line px-2.5 py-1 text-[11px] text-paper hover:bg-line/40 disabled:opacity-50"
                title="Re-read this source from scratch."
              >
                Rebuild
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(() => api.cancelIngestJob(job.id))}
              className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ember hover:bg-line/40 disabled:opacity-50"
              title="Drop this job — it won't be retried."
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * The single, prominent banner shown when ingestion has auto-paused because the
 * AI provider isn't working (#circuit). It replaces what would otherwise be one
 * identical failure card per file — one cause, one explanation, one fix. meOS
 * resumes on its own once the provider works again; "Retry now" forces it.
 */
function ProviderHoldBanner({
  hold,
  busy,
  onResume,
}: {
  hold: NonNullable<SourceHealth["providerHold"]>;
  busy: boolean;
  onResume: () => void;
}) {
  const explained = explainError(hold.reason);
  return (
    <div className="flex items-start gap-3 rounded-xl border border-ember/50 bg-ember/5 px-4 py-3.5">
      <AlertOctagon className="mt-0.5 size-5 shrink-0 text-ember" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-paper">
          {explained?.title ?? "AI provider isn’t working"} — reading is paused
        </p>
        <p className="mt-0.5 text-[13px] text-faded">{hold.reason}</p>
        <p className="mt-1.5 text-[11px] text-dim">
          Paused {formatRelative(hold.since)} · meOS will resume on its own once the provider works
          again.
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onResume}
        className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11px] text-paper hover:bg-line/40 disabled:opacity-50"
      >
        <Play className="size-3" /> Retry now
      </button>
    </div>
  );
}

/**
 * Group failing jobs by their plain-English cause (+ failing step) so a burst of
 * identical failures collapses into one actionable row instead of N. First-seen
 * order is preserved. The circuit-breaker already keeps provider outages OUT of
 * this list (those jobs stay pending under the hold), so this mainly tidies up
 * repeated document/parse failures.
 */
function groupFailures(
  jobs: IngestJob[],
): Array<{ key: string; title: string; jobs: IngestJob[] }> {
  const groups = new Map<string, { key: string; title: string; jobs: IngestJob[] }>();
  for (const job of jobs) {
    const { step, message } = parseFailure(job.lastError);
    const title = explainError(message)?.title ?? "Failed";
    const key = `${step ?? job.stage}::${title}`;
    const group = groups.get(key) ?? { key, title, jobs: [] };
    group.jobs.push(job);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** A collapsed group of identical failures: one cause, a count, and a suggested
 * fix; expand to act on the individual jobs. */
function FailureGroup({
  group,
  busy,
  onAction,
}: {
  group: { key: string; title: string; jobs: IngestJob[] };
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const explained = explainError(parseFailure(group.jobs[0]!.lastError).message);
  return (
    <li className="overflow-hidden rounded-xl border border-line bg-desk">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-card/40"
      >
        <XCircle className="size-4 shrink-0 text-ember" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-paper">{group.title}</span>
            <span className="shrink-0 rounded-full border border-ember/40 px-1.5 py-0.5 text-[10px] font-medium text-ember">
              {group.jobs.length} items
            </span>
          </div>
          {explained?.detail && (
            <div className="mt-0.5 text-[11px] text-dim">{explained.detail}</div>
          )}
        </div>
        <ChevronRight
          className={cn("size-4 shrink-0 text-dim transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="border-t border-line">
          {explained?.fix && (
            <p className="px-4 pt-3 text-[12px] text-amber-400">{explained.fix}</p>
          )}
          <ul className="space-y-2 p-3">
            {group.jobs.map((job) => (
              <ProblemRow key={job.id} job={job} busy={busy} onAction={onAction} />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export function HealthView() {
  const catalog = useConnectorCatalog();
  const [source, setSource] = useState<SourceHealth | null>(null);
  const [runtime, setRuntime] = useState<RuntimeHealth | null>(null);
  const [metrics, setMetrics] = useState<IngestMetrics | null>(null);
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showWorkers, setShowWorkers] = useState(false);
  const [showTech, setShowTech] = useState(false);

  const refresh = useCallback(() => {
    api
      .getSourceHealth()
      .then((d) => {
        setSource(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api
      .getRuntimeHealth()
      .then(setRuntime)
      .catch(() => {});
    api
      .getIngestMetrics()
      .then(setMetrics)
      .catch(() => {});
    api
      .listIngestJobs()
      .then((r) => setJobs(r.jobs))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Every control (retry/rebuild/cancel/pause/dead-letter) runs through here so
  // a single `busy` flag guards against double-clicks and we always re-poll after.
  const runAction = useCallback(
    (action: () => Promise<unknown>) => {
      setBusy(true);
      action()
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          setBusy(false);
          refresh();
        });
    },
    [refresh],
  );

  if (error && !source) {
    return (
      <div className="mt-6 rounded-xl border border-line bg-desk px-4 py-3 text-sm text-ember">
        Couldn’t load health: {error}
      </div>
    );
  }
  if (!source) {
    return <div className="mt-6 text-sm text-dim">Loading health…</div>;
  }

  const engine = engineStatus(
    runtime?.workers ?? [],
    metrics?.paused ?? false,
    source.pipeline.running,
  );
  const engineMeta = ENGINE_META[engine.status];

  // "Needs attention": the failing jobs are the single source of truth (the old
  // source-health recentFailures were the same rows). Watcher/connector errors
  // surface on their own cards, so they're counted but not re-listed here.
  const failingJobs = jobs.filter((j) => j.state === "failed" || j.state === "dead-letter");
  const watcherProblem = source.localFolders.watcherError ? 1 : 0;
  const connectorProblems = source.connectors.providers
    .flatMap((p) => p.kinds)
    .filter((k) => k.enabled && k.health === "degraded").length;
  const attentionCount =
    failingJobs.length + watcherProblem + connectorProblems + (engine.status === "problem" ? 1 : 0);
  const running = source.runningJobs.length || source.pipeline.running;
  const deadLetterTotal = metrics ? metrics.queues.reduce((sum, q) => sum + q.deadLetter, 0) : 0;

  return (
    <div className="mt-6 space-y-8">
      {/* Status hero — the one-line verdict. A provider hold is THE thing to know,
          so when present it stands in for the generic hero. */}
      {source.providerHold ? (
        <ProviderHoldBanner
          hold={source.providerHold}
          busy={busy}
          onResume={() => runAction(api.resumeIngest)}
        />
      ) : attentionCount > 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3">
          <AlertTriangle className="size-5 shrink-0 text-amber-500" />
          <div>
            <p className="text-sm font-medium text-paper">
              {attentionCount} thing{attentionCount === 1 ? "" : "s"} need your attention
            </p>
            <p className="text-xs text-dim">
              Jump to “Needs attention” below to see what broke and fix it.
            </p>
          </div>
        </div>
      ) : running > 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-line bg-desk px-4 py-3">
          <Loader2 className="size-5 shrink-0 animate-spin text-lamp" />
          <p className="text-sm text-faded">
            meOS is reading {running} item{running === 1 ? "" : "s"} right now…
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-4 py-3">
          <CheckCircle2 className="size-5 shrink-0 text-emerald-500" />
          <p className="text-sm text-paper">
            Everything’s healthy — meOS has read everything it could.
          </p>
        </div>
      )}

      {/* Background engine — one verdict for all background processing. */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-faded">
          <Cpu className="size-4" /> Background engine
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-1.5 text-xs font-medium",
              engineMeta.tone,
            )}
          >
            <span className={cn("size-1.5 rounded-full", engineMeta.dot)} />
            {engineMeta.label}
          </span>
        </h3>
        <div className="rounded-xl border border-line bg-desk px-4 py-3">
          <div className="flex items-center gap-3">
            <p className="flex-1 text-sm text-faded">{engine.detail || engineMeta.blurb}</p>
            {metrics && (
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction(metrics.paused ? api.resumeIngest : api.pauseIngest)}
                className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11px] text-paper hover:bg-line/40 disabled:opacity-50"
              >
                {metrics.paused ? (
                  <>
                    <Play className="size-3" /> Resume
                  </>
                ) : (
                  <>
                    <Pause className="size-3" /> Pause
                  </>
                )}
              </button>
            )}
          </div>
          {runtime && runtime.workers.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowWorkers((s) => !s)}
                className="mt-3 flex items-center gap-1 text-[11px] text-dim hover:text-faded"
              >
                <ChevronRight
                  className={cn("size-3.5 transition-transform", showWorkers && "rotate-90")}
                />
                {showWorkers ? "Hide" : "Show"} the {runtime.workers.length} workers
              </button>
              {showWorkers && (
                <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                  {runtime.workers.map((w) => {
                    const label = workerLabel(w.name);
                    return (
                      <li
                        key={w.name}
                        className="flex items-center gap-2.5 rounded-lg border border-line bg-card/40 px-3 py-2"
                        title={label.blurb}
                      >
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            w.status === "error"
                              ? "bg-ember"
                              : w.status === "running"
                                ? "bg-lamp working-dot"
                                : "bg-dim",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-xs text-paper">
                          {label.label}
                        </span>
                        {w.lastError && (
                          <AlertTriangle
                            className="size-3.5 shrink-0 text-ember"
                            aria-label={w.lastError}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </section>

      {/* Your folders. */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-faded">
          <FolderOpen className="size-4" /> Your folders
          <span className="ml-auto">
            <HealthBadge health={source.localFolders.health} />
          </span>
        </h3>
        <div className="rounded-xl border border-line bg-desk px-4 py-3">
          <p className="mb-2 text-xs text-dim">
            {source.localFolders.folders.length === 0
              ? "No folders watched yet — add one in Settings."
              : `Watching ${source.localFolders.folders.length} folder${
                  source.localFolders.folders.length === 1 ? "" : "s"
                }`}
            {source.localFolders.lastIndexedAt && (
              <> · last indexed {formatRelative(source.localFolders.lastIndexedAt)}</>
            )}
          </p>
          <CountsRow counts={source.localFolders.counts} />
          {source.localFolders.watcherError && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-ember">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              {source.localFolders.watcherError}
            </p>
          )}
          {source.localFolders.health === "healthy" && source.localFolders.folders.length > 0 && (
            <p className="mt-2 text-[11px] text-dim">All watched folders are up to date.</p>
          )}
        </div>
      </section>

      {/* Connected services. */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-faded">
          Connected services
          <span className="ml-auto">
            <HealthBadge health={source.connectors.health} />
          </span>
        </h3>
        {source.connectors.providers.every((p) => !p.connected) ? (
          <div className="rounded-xl border border-line bg-desk px-4 py-3 text-sm text-dim">
            No services connected. Connect a service in Settings to index your contacts, calendar,
            email and tasks.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* One block per connected provider account, joined to the catalog for
                its brand mark. */}
            {source.connectors.providers
              .filter((p) => p.connected)
              .map((p) => {
                const Logo = brandLogo(catalog.connector(p.provider)?.logo);
                return (
                  <div
                    key={p.provider}
                    className="overflow-hidden rounded-xl border border-line bg-desk"
                  >
                    <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
                      <Logo className="size-5 shrink-0" />
                      <span className="text-sm font-medium text-paper">{p.displayName}</span>
                      {p.accountEmail && (
                        <span className="ml-auto truncate text-xs text-dim">{p.accountEmail}</span>
                      )}
                    </div>
                    {/* Its services. */}
                    <div className="grid gap-2 p-3 sm:grid-cols-2">
                      {p.kinds.map((k) => (
                        <ConnectorCard
                          key={k.kind}
                          k={k}
                          brand={catalog.brandForSourceType(`${p.provider}:${k.kind}`)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </section>

      {/* Needs attention — every failure, with the step it failed at + fixes. */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-faded">
          Needs attention
          {failingJobs.length > 0 && (
            <span className="font-mono text-[11px] text-dim">({failingJobs.length})</span>
          )}
          {deadLetterTotal > 0 && (
            <span className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction(api.retryDeadLetter)}
                className="rounded-md border border-line px-2 py-0.5 text-[11px] text-paper hover:bg-line/40 disabled:opacity-50"
              >
                Retry all
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => runAction(api.clearDeadLetter)}
                className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ember hover:bg-line/40 disabled:opacity-50"
              >
                Clear
              </button>
            </span>
          )}
        </h3>
        {failingJobs.length === 0 ? (
          <p className="text-sm text-dim">
            Nothing has failed — everything meOS tried to read went through.
          </p>
        ) : (
          <ul className="space-y-2">
            {groupFailures(failingJobs).map((group) =>
              group.jobs.length === 1 ? (
                <ProblemRow
                  key={group.jobs[0]!.id}
                  job={group.jobs[0]!}
                  busy={busy}
                  onAction={runAction}
                />
              ) : (
                <FailureGroup key={group.key} group={group} busy={busy} onAction={runAction} />
              ),
            )}
          </ul>
        )}
      </section>

      {/* Skipped / unsupported file types. */}
      {source.skippedTypes.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-medium text-faded">File types meOS skipped</h3>
          <div className="flex flex-wrap gap-2">
            {source.skippedTypes.map((t) => (
              <span
                key={t.extension}
                className="rounded-full border border-line bg-desk px-2.5 py-1 text-xs text-dim"
                title={`${t.count} file${t.count === 1 ? "" : "s"} of this type were not indexed`}
              >
                .{t.extension} · {t.count}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-dim">
            These formats aren’t indexed yet, so their contents aren’t searchable.
          </p>
        </section>
      )}

      {/* Technical details — deep telemetry, off by default. */}
      {metrics && (
        <section>
          <button
            type="button"
            onClick={() => setShowTech((s) => !s)}
            className="flex items-center gap-1 text-sm font-medium text-faded hover:text-paper"
          >
            <ChevronRight className={cn("size-4 transition-transform", showTech && "rotate-90")} />
            Technical details
          </button>
          {showTech && <TechnicalDetails metrics={metrics} />}
        </section>
      )}

      <p className="text-[11px] text-dim">
        Updated {formatTime(source.generatedAt)} · auto-refreshes every 4s
      </p>
    </div>
  );
}

/** The deep ingest telemetry, curated with tooltips and kept out of the way. */
function TechnicalDetails({ metrics }: { metrics: IngestMetrics }) {
  return (
    <div className="mt-3 space-y-6">
      {/* Queues — backlog + throughput. */}
      <div>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">Queues</h4>
        <ul className="space-y-2">
          {metrics.queues.map((q) => (
            <li key={q.queue} className="rounded-xl border border-line bg-desk px-4 py-3">
              <div className="mb-2 font-mono text-sm text-paper">{q.queue}</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                <Stat label="pending" value={q.pending} hint="Waiting to run." />
                <Stat label="processing" value={q.processing} hint="Running right now." />
                <Stat
                  label="retrying"
                  value={q.retrying}
                  hint="Failed once but still within their retry budget."
                />
                <Stat
                  label="dead-letter"
                  value={q.deadLetter}
                  hint="Exhausted retries — need a manual retry."
                />
                <Stat
                  label="completed"
                  value={q.completed}
                  hint="Finished successfully (within retention)."
                />
                <Stat
                  label="avg s"
                  value={q.avgDurationSeconds}
                  hint="Mean wall-clock seconds per completed job."
                />
                <Stat
                  label="oldest queued"
                  value={q.oldestQueuedAt ? formatTime(q.oldestQueuedAt) : "—"}
                  hint="When the oldest still-pending job was queued."
                />
              </div>
            </li>
          ))}
          {metrics.queues.length === 0 && <li className="text-sm text-dim">No queues yet.</li>}
        </ul>
        <p
          className="mt-2 text-[11px] text-dim"
          title="The most batches admitted to processing per pump tick."
        >
          Backpressure cap: {metrics.backpressure.maxBatchesPerPump}/tick
        </p>
      </div>

      {/* Stages — per-step timing + outcomes. */}
      <div>
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">Stages</h4>
        <ul className="space-y-2">
          {metrics.stages.map((s) => {
            const info = stepLabel(s.stage);
            return (
              <li key={s.stage} className="rounded-xl border border-line bg-desk px-4 py-3">
                <div className="mb-2 text-sm text-paper" title={info.blurb}>
                  {info.label} <span className="font-mono text-[11px] text-dim">{s.stage}</span>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <Stat
                    label="completed"
                    value={s.completed}
                    hint="Runs that finished this step successfully."
                  />
                  <Stat label="failed" value={s.failed} hint="Runs that failed this step." />
                  <Stat
                    label="dead-letter"
                    value={s.deadLetter}
                    hint="Runs that gave up at this step."
                  />
                  <Stat
                    label="processing"
                    value={s.processing}
                    hint="Runs in this step right now."
                  />
                  <Stat
                    label="avg s"
                    value={s.avgDurationSeconds}
                    hint="Mean seconds spent in this step."
                  />
                  <Stat
                    label="total s"
                    value={s.totalDurationSeconds}
                    hint="Total seconds spent in this step."
                  />
                </div>
              </li>
            );
          })}
          {metrics.stages.length === 0 && (
            <li className="text-sm text-dim">No stage history yet.</li>
          )}
        </ul>
      </div>

      {/* Recovery + cost. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-desk px-4 py-3">
          <h4 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-dim">
            <RotateCw className="size-3.5" /> Recovery
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              label="recovered"
              value={metrics.recovery.recovered}
              hint="Jobs reclaimed after a crash and re-run."
            />
            <Stat
              label="dead-lettered"
              value={metrics.recovery.deadLettered}
              hint="Jobs that exhausted retries and were parked."
            />
          </div>
        </div>
        <div className="rounded-xl border border-line bg-desk px-4 py-3">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-dim">
            Extraction cost
          </h4>
          {metrics.costs.length === 0 ? (
            <div className="text-sm text-dim">No extractions recorded yet.</div>
          ) : (
            <ul className="space-y-1.5">
              {metrics.costs.map((c, i) => (
                <li key={i} className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate font-mono text-paper">
                    {c.modelId} · {c.strategy} · v{c.promptVersion}
                  </span>
                  <span className="shrink-0 font-mono text-dim">
                    {c.tokenUsage} tok
                    {c.estimatedCostUsd !== null && ` · $${c.estimatedCostUsd.toFixed(4)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
