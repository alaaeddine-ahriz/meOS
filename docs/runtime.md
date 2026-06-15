# Runtime — background workers

meOS runs as a **single local process** (`@meos/server`). It is not a hidden
monolith: the process is a small set of named **background workers**, each
wrapped behind a uniform `Worker` interface and held in a registry on the app
context (`ctx.workers`). `main.ts` drives the process lifecycle through that
registry, and `GET /api/runtime` exposes every worker's health so the UI can
show whether ingestion, connectors, the scheduler, and wiki regeneration are
healthy.

This document is the runtime graph: each background component, the
queue/event/DB/filesystem state it owns, and its lifecycle.

## The worker interface

```ts
interface Worker {
  readonly name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  health(): {
    name: string;
    status: "idle" | "running" | "stopped" | "error";
    detail?: string;
    lastError: string | null;
    lastRunAt: string | null;
  };
}
```

- `start`/`stop` delegate to the underlying component **unchanged** — the
  wrappers are behavior-preserving.
- `health()` is **read-only**: it only reads existing state (queue depth, cron
  next-run, timer counts, last error). It never mutates the worker.

`WorkerRegistry` (`packages/server/src/runtime/worker.ts`) holds the workers in
startup order. `startAll()` starts them in registration order; `stopAll()` stops
them in reverse. The contract shape lives in `@meos/contracts`
(`schemas/runtime.ts`: `WorkerHealthSchema`, `RuntimeHealthSchema`).

## Startup / shutdown ordering

Defined in `main.ts`, preserving the historical sequence:

```
startup:  watcher → connectors → scheduler   (+ queue workers, no-op start)
shutdown: scheduler → connectors → watcher   (reverse registration order)
```

The watcher and connector workers are registered on the context in that order;
the scheduler worker is appended in `main.ts` once its `Cron` is built, so it
starts last. The ingest and wiki queue workers are queue-driven and have no-op
`start`/`stop` (the queues live and drain with the context), so they do not
affect ordering.

## The workers

### 1. Folder watcher — `WatcherWorker` wraps `FolderWatcher`

- **Owns:** a `chokidar` watch over the user's registered folders.
- **Writes:** for each new/changed supported file, pushes an ingest job onto the
  **shared ingest queue** (`ctx.queue`). DB writes happen inside that job via the
  pipeline + the ingest ledger (`recordIngestedFile`, `upsertInboxItemForFile`).
  Files are read in place — never moved or modified.
- **Lifecycle:** `start()` attaches every registered folder; `stop()` closes the
  chokidar watcher. `health()` reports `idle` while watching, `stopped`
  otherwise.

### 2. Connector sync — `ConnectorSyncWorker` wraps `ConnectorManager`

- **Owns:** one `setInterval` timer per enabled `(account, kind)` for Google
  connectors (gmail / calendar / contacts).
- **Writes:** each timer enqueues a `syncConnector` job onto the **shared ingest
  queue**, so connector merges serialise with file ingest. Sync results are
  logged; ingested items flow through the pipeline (DB writes).
- **Events:** `onSchedule` triggers `syncAllEnabled()` (a nightly delta pass over
  every enabled kind).
- **Lifecycle:** `start()` builds the timers from persisted per-kind schedule;
  `stop()` clears them. `health()` reports how many timers are armed.

### 3. Scheduler / consolidation — `SchedulerWorker` wraps a croner `Cron`

- **Owns:** a single cron (`config.consolidation.cron`) created by
  `startScheduler(ctx)`.
- **Writes:** on each tick it pushes an **exclusive** job onto the ingest queue
  that emits `onSchedule`, runs `runConsolidation` (DB writes + wiki
  regeneration + a digest written to `dataDir/digests/<date>.md`), commits the
  regenerated pages + digest via git, and optionally git-auto-syncs.
- **Lifecycle:** the `Cron` is created already scheduled, so `start()` is a
  no-op; `stop()` calls `Cron.stop()`. `health()` reads croner's `isBusy()`,
  `nextRun()`, and `previousRun()` (surfaced as `lastRunAt`).

### 4. Ingestion pipeline + ingest queue — `QueueWorker("ingest", ctx.queue)`

- **Owns:** the shared ingest `JobQueue` (concurrency 3). Jobs come from the
  watcher, connectors, the scheduler (exclusive), session crystallization, and a
  one-time wiki-page backfill at startup.
- **Writes:** the `IngestionPipeline` parses/embeds/extracts each document and
  merges entities/observations into the DB; `postMerge` runs contradiction
  detection. After a merge it calls `scheduleWikiRefresh` (see below).
- **Lifecycle:** queue-driven — no start/stop. `health()` reports
  `running`/`idle` plus depth (`N processing, M pending`).

### 5. Wiki regeneration — `QueueWorker("wiki", wikiQueue)`

- **Owns:** a dedicated wiki `JobQueue` (concurrency 1), decoupled from
  ingestion. Stale flags accumulate in the DB; a single coalesced pass
  (`scheduleWikiRefresh`) handles however many piled up.
- **Writes:** `wiki.regenerateStale()` regenerates pages (DB `wiki_pages` +
  markdown under `dataDir/wiki`), then `commitWikiChanges` commits them via git.
- **Lifecycle:** queue-driven — no start/stop. `health()` reports the wiki
  queue's depth.

### Session crystallization (not a standalone worker)

When a conversation closes, `onSessionEnd` pushes a `crystallizeSession` job onto
the **ingest queue** (so it surfaces under the `ingest` worker's health). A
successful crystallization calls `scheduleWikiRefresh`, feeding the wiki worker.
It is intentionally not a separate worker because it owns no timer or lifecycle
of its own — it is an event-driven producer for the existing ingest queue.

## Health surface

- `GET /api/runtime` → `{ workers: WorkerHealth[] }` — the full snapshot,
  validated against `RuntimeHealthSchema`.
- `GET /api/health` → `{ ok, llmProvider, workers: [{ name, status }] }` — the
  existing health check, with a compact worker status list appended. `ok` and
  `llmProvider` are unchanged (CI web-smoke depends on `ok`).

## Testing workers in isolation

Each wrapped worker can be constructed and health-checked **without booting the
server** — see `packages/server/test/worker.test.ts`, which exercises
`QueueWorker`, `SchedulerWorker`, and the `WorkerRegistry` ordering directly.
`packages/server/test/runtime.test.ts` asserts the `/api/runtime` and
`/api/health` shapes through the in-memory test harness.
