import { Activity, AlertTriangle, Gauge, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { api, type IngestMetrics, type RuntimeHealth } from "../api.js";
import { formatTime } from "../lib/datetime.js";

/**
 * The ingestion observability panel (#18): a read-only view of per-stage
 * timings + outcome counts, per-queue backlog/throughput, stale-job recovery
 * counters, the active backpressure cap, and best-effort cost telemetry — so a
 * slow or expensive ingest is diagnosable from the UI without reading logs. It
 * polls the same metrics surface the runtime worker-health endpoint draws from,
 * reusing the activity feed's card + status-dot vocabulary.
 */
const STATUS_DOTS: Record<string, string> = {
  idle: "bg-dim",
  running: "bg-lamp working-dot",
  stopped: "bg-dim",
  error: "bg-ember",
};

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-dim">{label}</span>
      <span className="font-mono text-sm text-paper">{value}</span>
    </div>
  );
}

export function IngestMetricsView() {
  const [metrics, setMetrics] = useState<IngestMetrics | null>(null);
  const [health, setHealth] = useState<RuntimeHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .getIngestMetrics()
      .then((m) => {
        setMetrics(m);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api
      .getRuntimeHealth()
      .then(setHealth)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (error) {
    return (
      <div className="mt-6 rounded-xl border border-line bg-desk px-4 py-3 text-sm text-ember">
        Couldn’t load ingestion metrics: {error}
      </div>
    );
  }

  if (!metrics) {
    return <div className="mt-6 text-sm text-dim">Loading ingestion metrics…</div>;
  }

  return (
    <div className="mt-6 space-y-8">
      {/* Workers — reuse the runtime worker-health snapshot. */}
      {health && (
        <section>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-faded">
            <Activity className="h-4 w-4" /> Workers
          </h3>
          <ul className="grid gap-2 sm:grid-cols-2">
            {health.workers.map((w) => (
              <li
                key={w.name}
                className="flex items-center gap-3 rounded-xl border border-line bg-desk px-4 py-3"
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    STATUS_DOTS[w.status] ?? "bg-dim",
                  )}
                  title={w.status}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm text-paper">{w.name}</div>
                  {w.detail && <div className="truncate text-xs text-dim">{w.detail}</div>}
                </div>
                {w.lastError && (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-ember" aria-label={w.lastError} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Queues — backlog + throughput. */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-faded">
          <Gauge className="h-4 w-4" /> Queues
          <span className="ml-auto font-mono text-[11px] text-dim">
            backpressure cap: {metrics.backpressure.maxBatchesPerPump}/tick
          </span>
        </h3>
        <ul className="space-y-2">
          {metrics.queues.map((q) => (
            <li key={q.queue} className="rounded-xl border border-line bg-desk px-4 py-3">
              <div className="mb-2 font-mono text-sm text-paper">{q.queue}</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                <Stat label="pending" value={q.pending} />
                <Stat label="processing" value={q.processing} />
                <Stat label="retrying" value={q.retrying} />
                <Stat label="dead-letter" value={q.deadLetter} />
                <Stat label="completed" value={q.completed} />
                <Stat label="avg s" value={q.avgDurationSeconds} />
                <Stat
                  label="oldest queued"
                  value={q.oldestQueuedAt ? formatTime(q.oldestQueuedAt) : "—"}
                />
              </div>
            </li>
          ))}
          {metrics.queues.length === 0 && <li className="text-sm text-dim">No queues yet.</li>}
        </ul>
      </section>

      {/* Stages — per-stage timing + outcomes. */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-faded">Stages</h3>
        <ul className="space-y-2">
          {metrics.stages.map((s) => (
            <li key={s.stage} className="rounded-xl border border-line bg-desk px-4 py-3">
              <div className="mb-2 font-mono text-sm text-paper">{s.stage}</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="completed" value={s.completed} />
                <Stat label="failed" value={s.failed} />
                <Stat label="dead-letter" value={s.deadLetter} />
                <Stat label="processing" value={s.processing} />
                <Stat label="avg s" value={s.avgDurationSeconds} />
                <Stat label="total s" value={s.totalDurationSeconds} />
              </div>
            </li>
          ))}
          {metrics.stages.length === 0 && (
            <li className="text-sm text-dim">No stage history yet.</li>
          )}
        </ul>
      </section>

      {/* Recovery + cost. */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-desk px-4 py-3">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-faded">
            <RotateCw className="h-4 w-4" /> Recovery
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="recovered" value={metrics.recovery.recovered} />
            <Stat label="dead-lettered" value={metrics.recovery.deadLettered} />
          </div>
        </div>
        <div className="rounded-xl border border-line bg-desk px-4 py-3">
          <h3 className="mb-2 text-sm font-medium text-faded">Extraction cost</h3>
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
      </section>

      <p className="text-[11px] text-dim">
        Updated {formatTime(metrics.generatedAt)} · auto-refreshes every 3s
      </p>
    </div>
  );
}
