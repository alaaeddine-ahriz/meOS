# Runtime — background workers

meOS runs as a **single local process** (`@meos/server`) by default. It is not a
hidden monolith: the process is a small set of named **background workers**, each
wrapped behind a uniform `Worker` interface and held in a registry on the app
context (`ctx.workers`). `main.ts` drives the process lifecycle through that
registry, and `GET /api/runtime` exposes every worker's health so the UI can
show whether ingestion, connectors, embedding, the scheduler, and wiki
regeneration are healthy.

This document is the runtime graph: each background component, the
queue/event/DB/filesystem state it owns, and its lifecycle.

## Process roles

`resolveSplitRole()` (`packages/server/src/runtime/process-split.ts`) decides how
the workers are distributed across processes. The split is **opt-in and
conservative**:

- **`all`** (default) — every worker runs in this one process. Today's behavior.
- **`app`** — set `MEOS_WORKER_PROCESS=1`. The UI-facing process keeps only the
  **watcher** (filesystem events are light and it just enqueues); the heavy
  workers run in a forked **worker host** (`dist/worker-host.js`, supervised by
  `WorkerSupervisor`).
- **`worker`** — the role the forked host runs under: the durable ingest
  executor, embedding/wiki health, connector sync, and the scheduler.
- `MEOS_IN_PROCESS_WORKERS=1` is a hard kill switch that forces `all` regardless.

The `watcher → connectors → scheduler` start ordering is preserved within each
role. The rest of this document describes the workers as they run in `all` mode.

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

Workers are registered on the context (`context.ts`) in startup order; the
scheduler is appended last — in `main.ts` for `all`, in `worker-host.ts` for the
`worker` role — once its `Cron` is built. `startAll()` starts in registration
order, `stopAll()` in reverse:

```
startup:  watcher → connectors → ingest → embedding → wiki → scheduler
shutdown: scheduler → wiki → embedding → ingest → connectors → watcher
```

Only some workers do real work on start/stop: the watcher attaches/closes its
chokidar watch, the connector worker arms/clears its timers, the durable
**ingest** worker starts/stops the `DurableIngest` sweep, and the scheduler's
`Cron` is stopped on shutdown. The **embedding** and **wiki** queue workers are
queue-driven with no-op `start`/`stop` (the queues live and drain with the
context), so they do not affect ordering.

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

- **Owns:** one `setInterval` timer per enabled `(account, kind)` across **all**
  configured connectors (the manifest-driven connector framework — Google's
  contacts / calendar / gmail / tasks, GitHub, and any others), not just Google.
- **Writes:** each timer enqueues a connector-sync job onto the ingest path, so
  connector merges serialise with file ingest. Ingested items flow through the
  pipeline (DB writes); sync results are logged.
- **Events:** `onSchedule` triggers a delta pass over every enabled kind (the
  nightly consolidation tick).
- **Lifecycle:** `start()` builds the timers from the persisted per-kind
  schedule; `stop()` clears them. `health()` reports how many timers are armed
  (`activeTimerCount()`), or "no enabled connectors".

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

### 4. Durable ingest queue — `IngestQueueWorker("ingest", store, "extraction", durableIngest)`

- **Owns:** the **durable** extraction queue — jobs persisted in the SQLite
  `ingest_jobs` table (`queue = 'extraction'`), executed by an in-memory
  `JobQueue` (concurrency `INGEST_CONCURRENCY` = 3) that acts purely as the
  concurrency executor. Jobs come from the watcher, connectors, the scheduler,
  session crystallization, and a one-time wiki-page backfill at startup.
- **Writes:** the `IngestionPipeline` parses/embeds/extracts each document and
  merges entities/observations into the DB; `postMerge` runs contradiction
  detection. After a merge it calls `scheduleWikiRefresh` (see below).
- **Durability:** `DurableIngest` records every job so it survives a crash.
  `start()` runs crash recovery (reclaims in-flight jobs) plus a periodic
  stale-job-reclaim + retention sweep; `stop()` ends the sweep.
- **Health:** reports pending/processing depth plus failed and dead-letter
  counts off the persisted table.

### 5. Embedding queue — `IngestQueueWorker("embedding", store, "embedding")`

- **Owns:** the durable embedding queue (`ingest_jobs` with `queue = 'embedding'`).
- **Lifecycle:** health-only for now — it surfaces the embedding queue's depth
  but owns no sweep of its own (no-op `start`/`stop`).

### 6. Wiki regeneration — `QueueWorker("wiki", wikiQueue)`

- **Owns:** a dedicated wiki `JobQueue` (concurrency 1), decoupled from
  ingestion. Stale flags accumulate in the DB; a single coalesced pass
  (`scheduleWikiRefresh`) handles however many piled up.
- **Writes:** `wiki.regenerateStale()` regenerates pages (DB `wiki_pages` +
  markdown under `dataDir/wiki`), then `commitWikiChanges` commits them via git.
- **Lifecycle:** queue-driven — no start/stop. `health()` reports the wiki
  queue's depth.

### Session crystallization (not a standalone worker)

When a conversation closes, `onSessionEnd` enqueues a `crystallizeSession` job on
the in-memory ingest executor. A successful crystallization calls
`scheduleWikiRefresh`, feeding the wiki worker. It is intentionally not a
separate worker because it owns no timer or lifecycle of its own — it is an
event-driven producer for the ingest path.

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
