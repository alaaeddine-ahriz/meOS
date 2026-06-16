import fs from "node:fs";
import path from "node:path";
import {
  createEmbedder,
  createLlmClient,
  extractionModelId,
  crystallizeSession,
  detectContradictions,
  ensureDataDirs,
  IngestionPipeline,
  JobQueue,
  KnowledgeStore,
  loadConfig,
  loadProfileContext,
  loadSchema,
  MeosEvents,
  openDatabase,
  overlayStoredLlmConfig,
  SwitchableLlmClient,
  Vault,
  WikiWriter,
  type Embedder,
  type LlmConfig,
  type MeosConfig,
  type MeosDatabase,
  type WikiChange,
} from "@meos/core";
import { ActivityBus } from "./activity.js";
import { buildCommitMessage } from "./commit-message.js";
import { ConnectorManager } from "./connector-manager.js";
import { DurableIngest } from "./durable-ingest.js";
import { GitSync } from "./git.js";
import { WorkerRegistry } from "./runtime/worker.js";
import {
  ConnectorSyncWorker,
  IngestQueueWorker,
  QueueWorker,
  WatcherWorker,
} from "./runtime/workers.js";
import { FolderWatcher } from "./watcher.js";

/** How many documents may move through parse/embed/extract at once. */
const INGEST_CONCURRENCY = 3;

export interface AppContext {
  rootDir: string;
  config: MeosConfig;
  db: MeosDatabase;
  store: KnowledgeStore;
  llm: SwitchableLlmClient;
  embedder: Embedder;
  wiki: WikiWriter;
  vault: Vault;
  pipeline: IngestionPipeline;
  queue: JobQueue;
  /** The durable, resumable ingestion layer (#13): persisted jobs + retries. */
  durableIngest: DurableIngest;
  watcher: FolderWatcher;
  git: GitSync;
  events: MeosEvents;
  /** Live + persisted wiki-maintainer transcripts for the Activity view. */
  activity: ActivityBus;
  /** Background sync schedule for connected external accounts (Google). */
  connectors: ConnectorManager;
  /**
   * The background workers (watcher, connectors, scheduler, ingest/wiki queues)
   * behind a uniform lifecycle + health surface. `main.ts` drives start/stop
   * through this; the /api/runtime route reads each worker's health.
   */
  workers: WorkerRegistry;
}

/**
 * Commit a regeneration pass's wiki changes locally with a comprehensive
 * message, then record the commit so each document can be sliced back to its
 * own diff. Local-only — nothing is pushed until the user syncs to a remote.
 * Failures are logged, never fatal to ingestion.
 */
export async function commitWikiChanges(
  deps: Pick<AppContext, "git" | "store">,
  changes: WikiChange[],
  label?: string,
  extraPaths: string[] = [],
): Promise<void> {
  if (changes.length === 0 && extraPaths.length === 0) return;
  try {
    const { subject, message } = buildCommitMessage(changes, deps.store, label);
    // Scope the commit to exactly the changed pages (+ any digest) so the
    // commit's contents match its message and each document slices cleanly.
    const paths = [...new Set([...changes.map((c) => c.filePath), ...extraPaths])];
    if (!(await deps.git.commitPaths(paths, message))) return;
    const hash = await deps.git.headHash();
    if (hash) deps.store.recordWikiCommit(hash, subject, changes);
  } catch (error) {
    console.error(
      "[git] failed to commit wiki changes:",
      error instanceof Error ? error.message : error,
    );
  }
}

export function findRootDir(start = process.cwd()): string {
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function createContext(rootDir = findRootDir()): AppContext {
  const config = loadConfig(rootDir);
  ensureDataDirs(config);

  const db = openDatabase(path.join(config.dataDir, "meos.db"));
  const store = new KnowledgeStore(db);
  // Provider, model, and API keys are defined in Settings (persisted in the
  // DB) — overlay them onto the defaults before building the client.
  overlayStoredLlmConfig(config, store.getSetting<LlmConfig>("llm"));
  // Switchable so the Settings UI can change provider/model/key at runtime.
  const llm = new SwitchableLlmClient(createLlmClient(config));
  const embedder = createEmbedder(config.embedding.provider, config.embedding.model);
  // Records each page regeneration's agent transcript and streams it live.
  const activity = new ActivityBus(store);
  const wiki = new WikiWriter(
    store,
    llm,
    path.join(config.dataDir, "wiki"),
    embedder,
    activity.hook,
  );
  // The user's hand-authored note vault (Obsidian-style), distinct from the
  // system-compiled wiki — free-form markdown that cross-links via [[links]].
  const vault = new Vault(path.join(config.dataDir, "vault"));
  // The automation bus: core stages emit lifecycle events, the server subscribes.
  const events = new MeosEvents();
  events.on("onContradiction", ({ entityId }) => {
    const entity = store.getEntity(entityId);
    console.log(
      `[events] contradiction flagged on ${entity?.name ?? `entity ${entityId}`} — needs review`,
    );
  });

  // Wiki regeneration runs decoupled from ingestion: stale flags accumulate in
  // the DB, and a single queued pass handles however many piled up — a batch
  // of 50 watched files triggers one regen per touched entity, not 50.
  const wikiQueue = new JobQueue(1);
  let refreshQueued = false;
  const scheduleWikiRefresh = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    wikiQueue.push(async () => {
      refreshQueued = false;
      const changes = await wiki.regenerateStale();
      await commitWikiChanges({ git, store }, changes);
    });
  };

  const pipeline = new IngestionPipeline({
    store,
    llm,
    embedder,
    wiki,
    scheduleWikiRefresh,
    dataDir: config.dataDir,
    extractionModelId: extractionModelId(config),
    events,
    postMerge: async ({ merge }) => {
      const result = await detectContradictions(
        store,
        llm,
        merge.newObservationIds,
        loadSchema(config.dataDir),
        events,
      );
      const notes: string[] = [];
      if (result.superseded > 0) notes.push(`${result.superseded} fact(s) superseded`);
      if (result.contradictions > 0)
        notes.push(`${result.contradictions} contradiction(s) flagged`);
      return notes.join(", ") || undefined;
    },
  });
  const queue = new JobQueue(INGEST_CONCURRENCY);
  // The durable layer (#13): persists each ingestion unit, recovers crashed
  // jobs, retries failures with backoff, and prunes old completed history. The
  // in-memory queue above is only its concurrency executor.
  const durableIngest = new DurableIngest({ store, pipeline, queue });
  const watcher = new FolderWatcher({ store, pipeline, queue, durableIngest });
  const git = new GitSync(config.dataDir);
  // Background sync for connected external accounts. Pushes onto the same ingest
  // queue so connector merges serialise with file ingest. A nightly delta pass
  // also rides the consolidation schedule.
  const connectors = new ConnectorManager({ store, pipeline, queue });
  events.on("onSchedule", () => connectors.syncAllEnabled());

  // Light up the compiled-knowledge retrieval stream for pages written before
  // wiki_pages existed (upgrade path): backfill from disk, locally, once. First
  // prune pages that no longer warrant one — connector-only or factless entities
  // (e.g. people pulled from contacts) whose pages predate the reference-only
  // gating — so the upgrade self-heals without a manual job.
  queue.push(async () => {
    const pruned = wiki.pruneConnectorOnlyPages();
    if (pruned > 0) console.log(`[wiki] pruned ${pruned} page(s) for entities without wiki backing`);
    const filled = await wiki.backfillPages();
    if (filled > 0) console.log(`[wiki] backfilled ${filled} page(s) into the retrieval index`);
  });

  // When a conversation closes, distil it into a first-class session source so
  // its reasoning compounds instead of evaporating (crystallization).
  events.on("onSessionEnd", ({ conversationId }) => {
    queue.push(async () => {
      const crystal = await crystallizeSession({
        store,
        llm,
        embedder,
        conversationId,
        schema: loadSchema(config.dataDir),
        profile: loadProfileContext(config.dataDir),
      });
      if (crystal) {
        scheduleWikiRefresh();
        console.log(
          `[events] crystallized conversation ${conversationId}: ${crystal.merge.newObservationIds.length} new fact(s)`,
        );
      }
    });
  });

  // The runtime surface: each background component wrapped behind the uniform
  // Worker interface (see docs/runtime.md). Registered in startup order so the
  // registry's startAll preserves watcher → connectors; main.ts appends the
  // SchedulerWorker once it has built the Cron, keeping the historical
  // watcher → connectors → scheduler ordering. The ingest + wiki queues are
  // queue-driven (no start/stop of their own), surfaced for health only.
  const workers = new WorkerRegistry();
  workers.register(
    new WatcherWorker(watcher),
    new ConnectorSyncWorker(connectors),
    // The durable extraction queue (#13) owns the persisted-job sweep: startAll
    // triggers crash recovery + the periodic stale-job/retention timer. The
    // embedding queue is surfaced for health only (it has no sweep of its own).
    new IngestQueueWorker("ingest", store, "extraction", durableIngest),
    new IngestQueueWorker("embedding", store, "embedding"),
    new QueueWorker("wiki", wikiQueue, "wiki regeneration"),
  );

  return {
    rootDir,
    config,
    db,
    store,
    llm,
    embedder,
    wiki,
    vault,
    pipeline,
    queue,
    durableIngest,
    watcher,
    git,
    events,
    activity,
    connectors,
    workers,
  };
}
