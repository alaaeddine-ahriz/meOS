import fs from "node:fs";
import path from "node:path";
import {
  createEmbedder,
  createLlmClient,
  detectContradictions,
  ensureDataDirs,
  IngestionPipeline,
  KnowledgeStore,
  loadConfig,
  openDatabase,
  SerialQueue,
  WikiWriter,
  type Embedder,
  type LlmClient,
  type MeosConfig,
  type MeosDatabase,
} from "@meos/core";

export interface AppContext {
  config: MeosConfig;
  db: MeosDatabase;
  store: KnowledgeStore;
  llm: LlmClient;
  embedder: Embedder;
  wiki: WikiWriter;
  pipeline: IngestionPipeline;
  queue: SerialQueue;
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
  const llm = createLlmClient(config);
  const embedder = createEmbedder(config.embedding.provider, config.embedding.model);
  const wiki = new WikiWriter(store, llm, path.join(config.dataDir, "wiki"));
  const pipeline = new IngestionPipeline({
    store,
    llm,
    embedder,
    wiki,
    postMerge: async ({ merge }) => {
      const result = await detectContradictions(store, llm, merge.newObservationIds);
      const notes: string[] = [];
      if (result.superseded > 0) notes.push(`${result.superseded} fact(s) superseded`);
      if (result.contradictions > 0) notes.push(`${result.contradictions} contradiction(s) flagged`);
      return notes.join(", ") || undefined;
    },
  });
  const queue = new SerialQueue();

  return { config, db, store, llm, embedder, wiki, pipeline, queue };
}
