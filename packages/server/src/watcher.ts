import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import {
  createLogger,
  SUPPORTED_EXTENSIONS,
  type IngestionPipeline,
  type JobQueue,
  type KnowledgeStore,
} from "@meos/core";
import type { DurableIngest } from "./durable-ingest.js";

const execFileAsync = promisify(execFile);
const log = createLogger("watcher");

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
    private readonly deps: {
      store: KnowledgeStore;
      pipeline: IngestionPipeline;
      queue: JobQueue;
      /** Durable ingestion (#13): file ingests are persisted + retryable. */
      durableIngest: DurableIngest;
    },
  ) {
    this.watcher = chokidar.watch([], {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      ignored: (filePath) => {
        const base = path.basename(filePath);
        // Dotfiles, and Office/LibreOffice owner-lock files ("~$report.docx",
        // ".~lock.report.odt#") — transient siblings of open documents that
        // only ever fail to parse and flood the feed.
        return base.startsWith(".") || base.startsWith("~$") || base.startsWith(".~lock.");
      },
    });
    this.watcher.on("add", (filePath) => this.consider(filePath));
    this.watcher.on("change", (filePath) => this.consider(filePath));
    this.watcher.on("unlink", (filePath) => this.forget(filePath));
    this.watcher.on("error", (error) => log.error({ err: error }, "watch error"));
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
    // Removing a watched folder is an explicit deletion: every source under it has
    // its latest revision marked `deleted`, so facts now backed only by those
    // outdated revisions get flagged rather than silently kept as current (#16).
    const { store } = this.deps;
    for (const source of store.sourcesUnderPath(folderPath)) {
      store.markSourceGone(source.id, "deleted");
    }
    for (const id of store.entityIdsWithStaleBackedFacts()) store.markWikiStale(id);
  }

  /**
   * A watched file disappeared from disk: mark its source's latest revision
   * `missing` (recoverable — the file may return) and flag any facts now backed
   * only by an outdated revision. The `ingested_files` ledger is left intact so
   * the content-hash dedup still short-circuits if the same bytes reappear.
   */
  private forget(filePath: string): void {
    if (!SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;
    const { store, queue } = this.deps;
    queue.push(async () => {
      store.markSourceGoneByPath(filePath, "missing");
    });
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
    // Cheap stat-only gate: files whose (path + mtime + size) we've already
    // absorbed never get past here, so a startup sweep of thousands of files
    // costs no reads. A pass only means "maybe changed" — the hash decides.
    if (!this.deps.store.fileNeedsIngest(filePath, stat.mtimeMs, stat.size)) return;

    const filename = path.basename(filePath);
    const { store, queue, durableIngest } = this.deps;
    queue.push(async () => {
      // Never read synchronously here: one file with stuck I/O would wedge
      // the whole event loop, taking the API down with it.
      if (await isDatalessPlaceholder(filePath)) {
        const { id } = store.upsertInboxItemForFile(filePath, filename);
        store.updateInboxItem(
          id,
          "failed",
          "Online-only cloud placeholder — download the file locally and it will be retried",
        );
        return;
      }
      let buffer: Buffer;
      try {
        buffer = await fs.promises.readFile(filePath);
      } catch (error) {
        const { id } = store.upsertInboxItemForFile(filePath, filename);
        store.updateInboxItem(id, "failed", error instanceof Error ? error.message : String(error));
        return;
      }

      // mtime/size moved but the bytes are identical (re-download, restore,
      // `touch`): refresh the ledger so we stop re-checking it, and skip the
      // LLM — no feed row, because nothing new actually arrived.
      const contentHash = createHash("sha256").update(buffer).digest("hex");
      if (store.fileContentUnchanged(filePath, contentHash)) {
        store.recordIngestedFile(filePath, stat.mtimeMs, stat.size, contentHash);
        return;
      }

      // A genuine new file or edit — only now does it become a feed event, so a
      // cosmetic touch never flashes a spurious "updated" row. The ledger is
      // recorded up front: durability now lives in the persisted ingest job
      // (#13), which retries on its own across restarts; the file ledger only
      // gates re-reads. If the job later dead-letters, a manual retry re-runs it.
      const { id: inboxItemId } = store.upsertInboxItemForFile(filePath, filename);
      store.recordIngestedFile(filePath, stat.mtimeMs, stat.size, contentHash);
      durableIngest.enqueueFile({
        filename,
        buffer,
        origin: "watch",
        path: filePath,
        inboxItemId,
      });
    });
  }
}
