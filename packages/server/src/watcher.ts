import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import { SUPPORTED_EXTENSIONS, type IngestionPipeline, type JobQueue, type KnowledgeStore } from "@meos/core";

const execFileAsync = promisify(execFile);

/**
 * macOS cloud placeholders ("online-only" iCloud/Dropbox/OneDrive files):
 * reading one blocks in the kernel until the provider materializes it, which
 * can be forever if the provider is gone. st_flags carries the SF_DATALESS
 * bit but Node's Stats doesn't expose st_flags, so ask stat(1).
 */
const SF_DATALESS = 0x40000000;

async function isDatalessPlaceholder(filePath: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    const { stdout } = await execFileAsync("/usr/bin/stat", ["-f", "%f", filePath]);
    return (Number.parseInt(stdout.trim(), 10) & SF_DATALESS) !== 0;
  } catch {
    return false;
  }
}

/**
 * Watches the folders the user registered in Settings. Files are read in
 * place — never moved or modified — and a ledger (path + mtime + size)
 * ensures each version of a file is absorbed exactly once, across restarts.
 * Unsupported formats are skipped silently rather than cluttering the Inbox.
 */
export class FolderWatcher {
  private readonly watcher: FSWatcher;

  constructor(
    private readonly deps: { store: KnowledgeStore; pipeline: IngestionPipeline; queue: JobQueue },
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

  /**
   * Detach and re-attach every watched folder so chokidar re-emits "add" for
   * all existing files. Paired with a cleared ingest ledger (e.g. after a
   * reset), this re-absorbs the folders from scratch without a restart.
   */
  rescan(): void {
    const folders = this.deps.store.listWatchedFolders().map((folder) => folder.path);
    for (const folder of folders) this.watcher.unwatch(folder);
    for (const folder of folders) this.watcher.add(folder);
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
      // Never read synchronously here: one file with stuck I/O would wedge
      // the whole event loop, taking the API down with it.
      if (await isDatalessPlaceholder(filePath)) {
        this.deps.store.updateInboxItem(
          inboxItemId,
          "failed",
          "Online-only cloud placeholder — download the file locally and it will be retried",
        );
        return;
      }
      let buffer: Buffer;
      try {
        buffer = await fs.promises.readFile(filePath);
      } catch (error) {
        this.deps.store.updateInboxItem(
          inboxItemId,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const outcome = await this.deps.pipeline.ingest(
        { kind: "file", filename, buffer, origin: "watch", path: filePath },
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
