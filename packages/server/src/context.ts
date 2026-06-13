import fs from "node:fs";
import path from "node:path";
import {
  createEmbedder,
  createLlmClient,
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
  WikiWriter,
  type Embedder,
  type LlmConfig,
  type MeosConfig,
  type MeosDatabase,
  type WikiChange,
} from "@meos/core";
import { buildCommitMessage } from "./commit-message.js";
import { GitSync } from "./git.js";
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
  pipeline: IngestionPipeline;
  queue: JobQueue;
  watcher: FolderWatcher;
  git: GitSync;
  events: MeosEvents;
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
    console.error("[git] failed to commit wiki changes:", error instanceof Error ? error.message : error);
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
  const wiki = new WikiWriter(store, llm, path.join(config.dataDir, "wiki"), embedder);
  // The automation bus: core stages emit lifecycle events, the server subscribes.
  const events = new MeosEvents();
  events.on("onContradiction", ({ entityId }) => {
    const entity = store.getEntity(entityId);
    console.log(`[events] contradiction flagged on ${entity?.name ?? `entity ${entityId}`} — needs review`);
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
      if (result.contradictions > 0) notes.push(`${result.contradictions} contradiction(s) flagged`);
      return notes.join(", ") || undefined;
    },
  });
  const queue = new JobQueue(INGEST_CONCURRENCY);
  const watcher = new FolderWatcher({ store, pipeline, queue });
  const git = new GitSync(config.dataDir);

  // Light up the compiled-knowledge retrieval stream for pages written before
  // wiki_pages existed (upgrade path): backfill from disk, locally, once.
  queue.push(async () => {
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
        console.log(`[events] crystallized conversation ${conversationId}: ${crystal.merge.newObservationIds.length} new fact(s)`);
      }
    });
  });

  return { rootDir, config, db, store, llm, embedder, wiki, pipeline, queue, watcher, git, events };
}
