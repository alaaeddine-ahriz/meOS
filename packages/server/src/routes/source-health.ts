import { sourceHealth } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import { connectorRegistry, deriveCoverageState } from "@meos/core";
import type { CoverageState } from "@meos/core";
import type { AppContext } from "../context.js";
import { routeSchema } from "../route-schema.js";

const tags = ["source-health"];

type HealthLabel = "healthy" | "degraded" | "disconnected";

/**
 * The shared health rollup: "disconnected" unless live, "degraded" when there's
 * a problem, else "healthy". Used for every category and section header.
 */
function rollupHealth(live: boolean, degraded: boolean): HealthLabel {
  if (!live) return "disconnected";
  return degraded ? "degraded" : "healthy";
}

/** Map a connector's coverage state → a user-facing health label. */
function connectorHealth(enabled: boolean, state: CoverageState): HealthLabel {
  // recent-only / partial / backfilling are all "working but not yet complete" —
  // healthy enough to use, surfaced with their precise state alongside.
  return rollupHealth(enabled, state === "failed");
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
  app.get(
    "/api/source-health",
    {
      schema: routeSchema({
        tags,
        summary: "Source health overview",
        response: sourceHealth.SourceHealthResponse,
        // Exposed over MCP so an agent can assess ingest/connector health.
        mcp: { expose: true, name: "source_health", safety: "read" },
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

      // --- Connectors (per-provider, driven entirely by the registry) ---
      const providers = connectorRegistry.list().map((connector) => {
        const provider = connector.manifest.id;
        const account = ctx.store.getConnectorAccount(provider);
        const connected = Boolean(account?.refresh_token || account?.access_token);
        const kinds = account
          ? connector.manifest.kinds.map((manifest) => {
              const kind = manifest.kind;
              const state = ctx.store.getSyncState(account.id, kind);
              const config = ctx.store.getSyncConfig(account.id, kind);
              const stats = ctx.store.connectorCoverageStats(account.id, kind);
              const coverageState = deriveCoverageState(config);
              const enabled = state?.enabled === 1;
              const last = config.lastSync;
              return {
                kind,
                // The kind's own display name is the product label — no hardcoded map.
                label: manifest.displayName,
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
              };
            })
          : [];
        return {
          provider,
          displayName: connector.manifest.displayName,
          connected,
          accountEmail: account?.account_email ?? null,
          health: rollupHealth(
            connected,
            kinds.some((k) => k.health === "degraded"),
          ),
          kinds,
        };
      });
      // Section header aggregate across every provider: degraded wins, then any
      // connected provider makes the section "healthy", else "disconnected".
      const connectorsHealth = rollupHealth(
        providers.some((p) => p.connected),
        providers.some((p) => p.health === "degraded"),
      );

      // --- Pipeline / queues (reuse the #18 aggregate) ---
      const queues = ctx.store.ingestQueueMetrics();
      const running = queues.reduce((n, q) => n + q.processing, 0);
      const pending = queues.reduce((n, q) => n + q.pending, 0);
      const failed = queues.reduce((n, q) => n + q.failed, 0);
      const deadLetter = queues.reduce((n, q) => n + q.deadLetter, 0);
      // The provider hold (#circuit) is the dominant signal when present — the
      // pipeline isn't really "healthy", it's stopped waiting on the provider.
      const providerHold = ctx.store.getIngestHold();
      const pipelineHealth = providerHold || deadLetter > 0 || failed > 0 ? "degraded" : "healthy";

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
          health: connectorsHealth,
          providers,
        },
        pipeline: { health: pipelineHealth, running, pending, failed, deadLetter },
        runningJobs,
        recentFailures,
        skippedTypes: ctx.store.inboxSkippedTypes(),
        providerHold,
        generatedAt: new Date().toISOString(),
      });
    },
  );
}
