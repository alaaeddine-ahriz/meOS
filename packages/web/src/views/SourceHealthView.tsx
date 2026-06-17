import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  FolderOpen,
  Loader2,
  Mail,
  RotateCw,
  User,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, type ConnectorHealth, type SourceHealth } from "../api.js";
import { formatTime } from "../lib/datetime.js";

/**
 * The Source health dashboard (#87): a non-technical, at-a-glance answer to
 * "Did meOS read the right things? What's missing? What should I fix?". It shows
 * one card per place meOS reads from (your watched folders + each connected
 * service), each with a healthy/needs-attention/disconnected badge, an
 * indexed/failed/skipped/pending breakdown, and the last successful sync time —
 * plus what's syncing right now, recent failures you can retry, and the file
 * types meOS left out. Composes the existing /api/source-health aggregate; it
 * never reimplements ingest metrics or retry.
 */

/** The visual vocabulary for the three product-level health labels. */
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

const KIND_ICON: Record<string, LucideIcon> = {
  contacts: User,
  calendar: CalendarDays,
  gmail: Mail,
  tasks: CheckSquare,
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

/** A small labelled count, mirroring IngestMetricsView's Stat idiom. */
function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
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
      <Stat label="indexed" value={counts.indexed} />
      <Stat
        label="failed"
        value={counts.failed}
        tone={counts.failed > 0 ? "text-ember" : undefined}
      />
      <Stat label="skipped" value={counts.skipped} />
      <Stat label="removed" value={counts.deleted} />
      <Stat label="pending" value={counts.pending} />
    </div>
  );
}

function ConnectorCard({ k }: { k: ConnectorHealth }) {
  const Icon = KIND_ICON[k.kind] ?? Mail;
  return (
    <div className="rounded-xl border border-line bg-desk px-4 py-3">
      <div className="mb-2 flex items-center gap-2.5">
        <Icon className="size-4 shrink-0 text-dim" />
        <span className="flex-1 text-sm font-medium text-paper">{k.label}</span>
        <HealthBadge health={k.health} />
      </div>
      <p className="mb-2 text-xs text-dim">
        {k.enabled ? (STATE_WORDING[k.state] ?? k.state) : "Turned off"}
        {k.lastSuccessAt && (
          <>
            {" · "}last synced {formatTime(k.lastSuccessAt)}
          </>
        )}
      </p>
      <CountsRow counts={k.counts} />
      {k.lastError && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-ember">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span className="break-words">{k.lastError}</span>
        </p>
      )}
    </div>
  );
}

export function SourceHealthView() {
  const [data, setData] = useState<SourceHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<number | null>(null);

  const refresh = useCallback(() => {
    api
      .getSourceHealth()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  const retry = async (id: number) => {
    setRetrying(id);
    try {
      await api.retryIngestJob(id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRetrying(null);
    }
  };

  if (error) {
    return (
      <div className="mt-6 rounded-xl border border-line bg-desk px-4 py-3 text-sm text-ember">
        Couldn’t load source health: {error}
      </div>
    );
  }
  if (!data) {
    return <div className="mt-6 text-sm text-dim">Loading source health…</div>;
  }

  return (
    <div className="mt-6 space-y-8">
      {/* Currently working banner. */}
      {(data.runningJobs.length > 0 || data.pipeline.running > 0) && (
        <div className="flex items-center gap-2 rounded-xl border border-line bg-desk px-4 py-3 text-sm text-faded">
          <Loader2 className="size-4 shrink-0 animate-spin text-lamp" />
          meOS is reading {data.runningJobs.length || data.pipeline.running} item
          {(data.runningJobs.length || data.pipeline.running) === 1 ? "" : "s"} right now…
        </div>
      )}

      {/* Local folders. */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-faded">
          <FolderOpen className="size-4" /> Your folders
          <span className="ml-auto">
            <HealthBadge health={data.localFolders.health} />
          </span>
        </h3>
        <div className="rounded-xl border border-line bg-desk px-4 py-3">
          <p className="mb-2 text-xs text-dim">
            {data.localFolders.folders.length === 0
              ? "No folders watched yet — add one in Settings."
              : `Watching ${data.localFolders.folders.length} folder${
                  data.localFolders.folders.length === 1 ? "" : "s"
                }`}
            {data.localFolders.lastIndexedAt && (
              <> · last indexed {formatTime(data.localFolders.lastIndexedAt)}</>
            )}
          </p>
          <CountsRow counts={data.localFolders.counts} />
          {data.localFolders.watcherError && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-ember">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              {data.localFolders.watcherError}
            </p>
          )}
          {data.localFolders.health === "healthy" && data.localFolders.folders.length > 0 && (
            <p className="mt-2 text-[11px] text-dim">All watched folders are up to date.</p>
          )}
        </div>
      </section>

      {/* Connected services. */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-faded">
          Connected services
          <span className="ml-auto">
            <HealthBadge health={data.connectors.health} />
          </span>
        </h3>
        {!data.connectors.connected ? (
          <div className="rounded-xl border border-line bg-desk px-4 py-3 text-sm text-dim">
            No services connected. Connect Google in Settings to index your contacts, calendar,
            email and tasks.
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {data.connectors.kinds.map((k) => (
              <ConnectorCard key={k.kind} k={k} />
            ))}
          </div>
        )}
      </section>

      {/* Recent failures with retry. */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-faded">Recent problems</h3>
        {data.recentFailures.length === 0 ? (
          <p className="text-sm text-dim">
            Nothing has failed — everything meOS tried to read went through.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.recentFailures.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-3 rounded-xl border border-line bg-desk px-4 py-3"
              >
                <XCircle className="size-4 shrink-0 text-ember" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm text-paper">
                    {f.kind} · {f.stage}
                    <span className="ml-2 text-[11px] text-dim">
                      {f.state === "dead-letter" ? "gave up after retries" : "will retry"} ·{" "}
                      {f.attempts}/{f.maxAttempts} tries
                    </span>
                  </div>
                  {f.lastError && <div className="truncate text-xs text-dim">{f.lastError}</div>}
                </div>
                {f.retryable && (
                  <button
                    type="button"
                    onClick={() => void retry(f.id)}
                    disabled={retrying === f.id}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-faded transition-colors hover:text-paper disabled:opacity-50"
                  >
                    <RotateCw className={cn("size-3.5", retrying === f.id && "animate-spin")} />
                    {retrying === f.id ? "Retrying…" : "Retry"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Skipped / unsupported file types. */}
      {data.skippedTypes.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-medium text-faded">File types meOS skipped</h3>
          <div className="flex flex-wrap gap-2">
            {data.skippedTypes.map((t) => (
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

      <p className="text-[11px] text-dim">
        Updated {formatTime(data.generatedAt)} · auto-refreshes every 4s
      </p>
    </div>
  );
}
