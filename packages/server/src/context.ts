import fs from "node:fs";
import path from "node:path";
import {
  createEmbedder,
  createLlmClient,
  detectContradictions,
  ensureDataDirs,
  IngestionPipeline,
  JobQueue,
  KnowledgeStore,
  loadConfig,
  openDatabase,
  overlayStoredLlmConfig,
  SwitchableLlmClient,
  WikiWriter,
  type Embedder,
  type LlmConfig,
  type MeosConfig,
  type MeosDatabase,
} from "@meos/core";
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
  const wiki = new WikiWriter(store, llm, path.join(config.dataDir, "wiki"));

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
      await wiki.regenerateStale();
    });
  };

  const pipeline = new IngestionPipeline({
    store,
    llm,
    embedder,
    wiki,
    scheduleWikiRefresh,
    postMerge: async ({ merge }) => {
      const result = await detectContradictions(store, llm, merge.newObservationIds);
      const notes: string[] = [];
      if (result.superseded > 0) notes.push(`${result.superseded} fact(s) superseded`);
      if (result.contradictions > 0) notes.push(`${result.contradictions} contradiction(s) flagged`);
      return notes.join(", ") || undefined;
    },
  });
  const queue = new JobQueue(INGEST_CONCURRENCY);
  const watcher = new FolderWatcher({ store, pipeline, queue });

  return { rootDir, config, db, store, llm, embedder, wiki, pipeline, queue, watcher };
}
