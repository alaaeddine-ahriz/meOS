import { sourceHealth } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import { connectorRegistry, deriveCoverageState } from "@meos/core";
import type { CoverageState } from "@meos/core";
import type { AppContext } from "../context.js";
import { routeSchema } from "../route-schema.js";

const tags = ["source-health"];

/** Product label per connector kind — non-technical, matches the Sources tab. */
const KIND_LABELS: Record<string, string> = {
  contacts: "Contacts",
  calendar: "Calendar events",
  gmail: "Emails",
  tasks: "Tasks",
};

/** Map a connector's coverage state → a user-facing health label. */
function connectorHealth(
  enabled: boolean,
  state: CoverageState,
): "healthy" | "degraded" | "disconnected" {
  if (!enabled) return "disconnected";
  if (state === "failed") return "degraded";
  // recent-only / partial / backfilling are all "working but not yet complete" —
  // healthy enough to use, surfaced with their precise state alongside.
  return "healthy";
}

/**
 * GET /api/source-health — the Source health dashboard (#87). A read-only,
 * product-language answer to "Did meOS read the right things? What's missing?
 * What should I fix?". Pure COMPOSITION over the existing aggregates: connector
 * sync-state (#88), the durable ingest ledger + metrics (#13/#18), the watched-
 * folder list, and the inbox status buckets. No new ingest/retry logic — the
 * client retries via the existing POST /api/ingest/jobs/:id/retry and the
 * per-connector sync/reset endpoints.
 */
export function registerSourceHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const google = connectorRegistry.get("google");

  app.get(
    "/api/source-health",
    {
      schema: routeSchema({
        tags,
        summary: "Source health overview",
        response: sourceHealth.SourceHealthResponse,
      }),
    },
    async () => {
      // --- Local folders ---
      const folders = ctx.store.listWatchedFolders().map((f) => ({ id: f.id, path: f.path }));
      const inbox = ctx.store.inboxHealthCounts();
      const watcherError = ctx.watcher.lastError ?? null;
      const localHealth =
        watcherError != null
          ? "degraded"
          : folders.length === 0
            ? "disconnected"
            : inbox.failed > 0
              ? "degraded"
              : "healthy";
      const localFolders = {
        health: localHealth,
        folders,
        counts: {
          indexed: inbox.indexed,
          failed: inbox.failed,
          skipped: inbox.skipped,
          // Local files don't soft-delete through the inbox; deletions are a
          // connector concept, so this is always 0 here.
          deleted: 0,
          pending: inbox.pending,
        },
        lastIndexedAt: inbox.lastIndexedAt,
        watcherError,
      };

      // --- Connectors ---
      const account = ctx.store.getConnectorAccount("google");
      const connected = Boolean(account?.refresh_token || account?.access_token);
      const kinds: Array<{
        kind: "contacts" | "calendar" | "gmail" | "tasks";
        label: string;
        health: "healthy" | "degraded" | "disconnected";
        enabled: boolean;
        state: CoverageState;
        counts: {
          indexed: number;
          failed: number;
          skipped: number;
          deleted: number;
          pending: number;
        };
        lastSuccessAt: string | null;
        lastFailureAt: string | null;
        lastError: string | null;
      }> = [];
      if (account && google) {
        for (const manifest of google.manifest.kinds) {
          const kind = manifest.kind as "contacts" | "calendar" | "gmail" | "tasks";
          const state = ctx.store.getSyncState(account.id, kind);
          const config = ctx.store.getSyncConfig(account.id, kind);
          const stats = ctx.store.connectorCoverageStats(account.id, kind);
          const coverageState = deriveCoverageState(config);
          const enabled = state?.enabled === 1;
          const last = config.lastSync;
          kinds.push({
            kind,
            label: KIND_LABELS[kind] ?? kind,
            health: connectorHealth(enabled, coverageState),
            enabled,
            state: coverageState,
            counts: {
              indexed: stats.itemCount,
              failed: last?.failed ?? 0,
              skipped: last?.skipped ?? 0,
              deleted: last?.deleted ?? 0,
              pending: 0,
            },
            lastSuccessAt: last?.okAt ?? null,
            lastFailureAt: last?.errorAt ?? null,
            lastError: last?.error ?? null,
          });
        }
      }
      const anyDegraded = kinds.some((k) => k.health === "degraded");
      const connectorsHealth = !connected ? "disconnected" : anyDegraded ? "degraded" : "healthy";

      // --- Pipeline / queues (reuse the #18 aggregate) ---
      const queues = ctx.store.ingestQueueMetrics();
      const running = queues.reduce((n, q) => n + q.processing, 0);
      const pending = queues.reduce((n, q) => n + q.pending, 0);
      const failed = queues.reduce((n, q) => n + q.failed, 0);
      const deadLetter = queues.reduce((n, q) => n + q.deadLetter, 0);
      const pipelineHealth = deadLetter > 0 ? "degraded" : failed > 0 ? "degraded" : "healthy";

      // --- Running jobs + recent failures (from the durable ledger) ---
      const jobs = ctx.store.listIngestJobs();
      const runningJobs = jobs
        .filter((j) => j.state === "processing")
        .map((j) => ({ id: j.id, kind: j.kind, stage: j.stage }));
      const recentFailures = jobs
        .filter((j) => j.state === "failed" || j.state === "dead-letter")
        .slice(0, 50)
        .map((j) => ({
          id: j.id,
          kind: j.kind,
          stage: j.stage,
          state: j.state,
          attempts: j.attempts,
          maxAttempts: j.max_attempts,
          lastError: j.last_error,
          updatedAt: j.updated_at,
          // A dead-letter job always needs a manual retry; a failed-but-budgeted
          // job is retryable too (resets its budget).
          retryable: true,
        }));

      return sourceHealth.SourceHealthResponse.parse({
        localFolders,
        connectors: {
          connected,
          accountEmail: account?.account_email ?? null,
          health: connectorsHealth,
          kinds,
        },
        pipeline: { health: pipelineHealth, running, pending, failed, deadLetter },
        runningJobs,
        recentFailures,
        skippedTypes: ctx.store.inboxSkippedTypes(),
        generatedAt: new Date().toISOString(),
      });
    },
  );
}
