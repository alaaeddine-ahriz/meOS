import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { SUPPORTED_EXTENSIONS, type IngestionPipeline, type KnowledgeStore, type SerialQueue } from "@meos/core";

/**
 * Watches the folders the user registered in Settings. Files are read in
 * place — never moved or modified — and a ledger (path + mtime + size)
 * ensures each version of a file is absorbed exactly once, across restarts.
 * Unsupported formats are skipped silently rather than cluttering the Inbox.
 */
export class FolderWatcher {
  private readonly watcher: FSWatcher;

  constructor(
    private readonly deps: { store: KnowledgeStore; pipeline: IngestionPipeline; queue: SerialQueue },
  ) {
    this.watcher = chokidar.watch([], {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      ignored: (filePath) => path.basename(filePath).startsWith("."),
    });
    this.watcher.on("add", (filePath) => this.consider(filePath));
    this.watcher.on("change", (filePath) => this.consider(filePath));
    this.watcher.on("error", (error) => console.error("watcher:", error));
  }

  /** Begin watching every folder currently registered. */
  start(): void {
    for (const folder of this.deps.store.listWatchedFolders()) {
      this.watcher.add(folder.path);
    }
  }

  addFolder(folderPath: string): void {
    this.watcher.add(folderPath);
  }

  removeFolder(folderPath: string): void {
    this.watcher.unwatch(folderPath);
  }

  close(): Promise<void> {
    return this.watcher.close();
  }

  private consider(filePath: string): void {
    if (!SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return; // gone between event and stat
    }
    if (!this.deps.store.fileNeedsIngest(filePath, stat.mtimeMs, stat.size)) return;

    const filename = path.basename(filePath);
    const inboxItemId = this.deps.store.createInboxItem(filename);
    this.deps.queue.push(async () => {
      const buffer = fs.readFileSync(filePath);
      const outcome = await this.deps.pipeline.ingest(
        { kind: "file", filename, buffer, origin: filePath },
        inboxItemId,
      );
      // A failure (e.g. LLM outage) stays off the ledger so the file is
      // retried on the next server start instead of being skipped forever.
      if (outcome.status !== "failed") {
        this.deps.store.recordIngestedFile(filePath, stat.mtimeMs, stat.size);
      }
    });
  }
}
