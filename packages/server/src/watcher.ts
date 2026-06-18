import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  createLogger,
  SUPPORTED_EXTENSIONS,
  type IngestionPipeline,
  type JobQueue,
  type KnowledgeStore,
  type Semaphore,
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

/**
 * Directory names never worth descending into: dependency/build trees that are
 * huge and never hold documents. Skipping them keeps a scan of a big folder
 * cheap. Dot-directories (.git, .obsidian, …) are pruned by the dotfile rule,
 * so only non-dot offenders live here.
 */
const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
  "venv",
]);

/** Watcher errors log at most once per window, with a running count, instead of
 * thousands of identical lines that themselves starve the event loop. */
const ERROR_LOG_THROTTLE_MS = 10_000;

/**
 * Recursive (whole-subtree) watching is supported by Node's fs.watch only on
 * macOS and Windows; elsewhere we rely on the periodic reconciliation scan
 * alone. One recursive watch costs a single OS handle for an entire tree —
 * unlike a watch-per-file model, its cost is independent of the file count.
 */
const RECURSIVE_WATCH_SUPPORTED = process.platform === "darwin" || process.platform === "win32";

/** Coalesce a burst of raw FS events for one path into a single consideration. */
const EVENT_DEBOUNCE_MS = 300;

/** A dropped-event safety net: re-walk every root this often. The live watch
 * delivers low latency; this guarantees eventual consistency even if the OS
 * coalesces or drops events (which recursive fs.watch is allowed to do). */
const RECONCILE_INTERVAL_MS = 10 * 60_000;

/**
 * Back-pressure for scans: while more than this many ingest jobs are already
 * queued, the walk pauses. A scan of a very large tree therefore drips files
 * onto the queue as it drains rather than enqueuing millions at once — the
 * embodiment of "instant isn't mandatory". Tune up for throughput, down for a
 * lighter memory/CPU footprint during big initial absorbs.
 */
const SCAN_QUEUE_HIGH_WATER = 500;
/** How long the walk parks when the queue is above the high-water mark. */
const SCAN_BACKOFF_MS = 200;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });

/**
 * Watches the folders the user registered in Settings. Files are read in
 * place — never moved or modified — and a ledger (path + mtime + size)
 * ensures each version of a file is absorbed exactly once, across restarts.
 * Unsupported formats are skipped silently rather than cluttering the Inbox.
 *
 * Two cooperating mechanisms, so the cost scales with how much *changes*, not
 * with how much is *watched*:
 *  - a recursive OS watch per root (one handle for a whole subtree) gives
 *    low-latency notice of changes where the platform supports it;
 *  - a reconciliation scan walks each root — on registration, and periodically
 *    as a safety net — enqueuing only files the ledger says are new/changed.
 *    The scan paces itself to the ingest queue, so even a very large folder is
 *    absorbed a batch at a time instead of all at once.
 */
export class FolderWatcher {
  /** Every registered root (resolved), watched or scan-only. */
  private readonly roots = new Set<string>();
  /** Live recursive watchers, by root. Empty on platforms without support. */
  private readonly watchers = new Map<string, fs.FSWatcher>();
  /** Roots with a scan currently in flight, so periodic + event-driven scans
   * of the same root don't overlap. */
  private readonly scanning = new Set<string>();
  /** Pending debounce timers, by absolute path. */
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconcileScheduled = false;
  private closed = false;

  /** Our own data dir (wiki/vault/db/WAL), never watched: its writes would feed
   * back as ingest events. Absolute + resolved so prefix matching is exact. */
  private readonly dataDir: string | null;
  private errorCount = 0;
  private lastErrorMessage: string | null = null;
  private lastErrorLoggedAt = 0;

  constructor(
    private readonly deps: {
      store: KnowledgeStore;
      pipeline: IngestionPipeline;
      queue: JobQueue;
      /** Durable ingestion (#13): file ingests are persisted + retryable. */
      durableIngest: DurableIngest;
      /** Shared FD budget bounding concurrent stats/reads, so a burst of events
       * can't exhaust the process descriptor limit (EMFILE). */
      fsLimit: Semaphore;
      /** The app's data dir — excluded from watching to avoid a write→ingest loop. */
      dataDir?: string;
    },
  ) {
    this.dataDir = deps.dataDir ? path.resolve(deps.dataDir) : null;
  }

  /** Begin watching + scanning every folder currently registered. */
  start(): void {
    this.closed = false;
    for (const folder of this.deps.store.listWatchedFolders()) this.addFolder(folder.path);
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => this.reconcileAll(), RECONCILE_INTERVAL_MS);
      this.reconcileTimer.unref();
    }
  }

  addFolder(folderPath: string): void {
    const root = path.resolve(folderPath);
    if (this.roots.has(root)) return;
    this.roots.add(root);
    // Absorb what's already there (paced by the queue), then watch for changes.
    void this.scanRoot(root);
    this.watchRoot(root);
  }

  removeFolder(folderPath: string): void {
    const root = path.resolve(folderPath);
    this.roots.delete(root);
    const watcher = this.watchers.get(root);
    if (watcher) {
      watcher.close();
      this.watchers.delete(root);
    }
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
   * Re-walk every registered root so each existing file is re-considered.
   * Paired with a cleared ingest ledger (e.g. after a reset), this re-absorbs
   * the folders from scratch without a restart.
   */
  rescan(): void {
    for (const root of this.roots) void this.scanRoot(root);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.scanning.clear();
  }

  /** Last watcher-level error, for the runtime health surface. */
  get lastError(): string | null {
    return this.lastErrorMessage;
  }

  /**
   * Attach a recursive watch for low-latency change notice. One handle covers
   * the whole subtree on supported platforms; elsewhere this is a no-op and the
   * periodic reconciliation scan is the only update path.
   */
  private watchRoot(root: string): void {
    if (!RECURSIVE_WATCH_SUPPORTED) return;
    try {
      const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        // A null filename means the OS gave us a change it couldn't name — fall
        // back to a reconciliation pass rather than guessing.
        if (filename == null) {
          this.scheduleReconcile();
          return;
        }
        this.onRawEvent(root, filename.toString());
      });
      watcher.on("error", (error) => this.handleError(error));
      this.watchers.set(root, watcher);
    } catch (error) {
      // e.g. the folder vanished between registration and watch — the scan
      // already ran; a later reconcile retries. Don't let one root take us down.
      this.handleError(error);
    }
  }

  /** Coalesce a raw FS event into a single delayed consideration per path. */
  private onRawEvent(root: string, filename: string): void {
    const full = path.resolve(root, filename);
    if (this.isIgnored(full, root)) return;
    const existing = this.pending.get(full);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pending.delete(full);
      this.dispatch(full);
    }, EVENT_DEBOUNCE_MS);
    timer.unref();
    this.pending.set(full, timer);
  }

  /** Resolve a settled path to the right action: present → consider, gone → forget. */
  private dispatch(full: string): void {
    // Through the FD budget: a burst of events fires every debounce timer at
    // once, and an unbounded fan-out of stats is what tips the process into EMFILE.
    this.deps.fsLimit
      .run(() => fs.promises.stat(full))
      .then(
        (stat) => {
          if (stat.isFile()) this.considerStat(full, stat);
        },
        () => this.forget(full),
      );
  }

  /** Debounced, de-duplicated full reconcile, for unnameable OS events. */
  private scheduleReconcile(): void {
    if (this.reconcileScheduled || this.closed) return;
    this.reconcileScheduled = true;
    const timer = setTimeout(() => {
      this.reconcileScheduled = false;
      this.reconcileAll();
    }, 2_000);
    timer.unref();
  }

  private reconcileAll(): void {
    for (const root of this.roots) void this.scanRoot(root);
  }

  /**
   * Walk a root depth-first, enqueuing supported files the ledger considers
   * new/changed. The extension is checked before any stat, so the bulk of a
   * disk (binaries, caches) costs one cheap string check and no syscall. The
   * walk yields the event loop and parks while the ingest queue is saturated,
   * so a large tree absorbs gradually instead of flooding memory.
   */
  private async scanRoot(root: string): Promise<void> {
    if (this.scanning.has(root) || this.closed) return;
    this.scanning.add(root);
    try {
      const stack: string[] = [root];
      while (stack.length > 0) {
        if (this.closed) return;
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
          entries = await this.deps.fsLimit.run(() =>
            fs.promises.readdir(dir, { withFileTypes: true }),
          );
        } catch {
          continue; // unreadable or vanished mid-walk
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (this.isIgnored(full, root)) continue;
          // Symlinks report as neither file nor directory here, so loops and
          // out-of-tree escapes are skipped without extra bookkeeping.
          if (entry.isDirectory()) {
            stack.push(full);
            continue;
          }
          if (!entry.isFile()) continue;
          if (!SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
          let stat: fs.Stats;
          try {
            stat = await this.deps.fsLimit.run(() => fs.promises.stat(full));
          } catch {
            continue;
          }
          this.considerStat(full, stat);
          // Back-pressure: let the queue drain before piling on more.
          while (this.deps.queue.pending > SCAN_QUEUE_HIGH_WATER && !this.closed) {
            await delay(SCAN_BACKOFF_MS);
          }
        }
      }
    } finally {
      this.scanning.delete(root);
    }
  }

  /**
   * Prune a path from watching/scanning. Returning true for a directory keeps
   * its whole subtree out — the difference between skipping `node_modules` and
   * walking every one inside it.
   */
  private isIgnored(filePath: string, root: string): boolean {
    // Our own data dir (wiki/db/WAL) is excluded wherever it sits — an absolute
    // match, independent of the watched root.
    if (this.dataDir) {
      const resolved = path.resolve(filePath);
      if (resolved === this.dataDir || resolved.startsWith(this.dataDir + path.sep)) return true;
    }
    // Prune if ANY segment between the root and the file is an ignored dir, a
    // dotfile/dot-dir (.git, .obsidian, …), or an Office/LibreOffice owner-lock
    // sibling ("~$report.docx", ".~lock.report.odt#"). Checking only the basename
    // was a gap: the scan prunes at the directory as it descends, but recursive
    // fs.watch delivers a *deep* path (…/node_modules/@next/env/package.json)
    // whose basename (package.json) hides the node_modules ancestor — so a single
    // `npm install` in a watched folder floods the queue and exhausts file
    // descriptors. Inspecting every segment lets an ignored ancestor prune its
    // whole subtree on the watch path too. Segments ABOVE the registered root are
    // the user's deliberate choice (a vault under ~/.config stays watched), so
    // they never disqualify.
    const rel = path.relative(root, filePath);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    for (const seg of rel.split(path.sep)) {
      if (seg.startsWith(".") || seg.startsWith("~$") || seg.startsWith(".~lock.")) return true;
      if (IGNORED_DIR_NAMES.has(seg)) return true;
    }
    return false;
  }

  /**
   * Fail soft on watcher errors. Throttle logging to one line per window with a
   * running count, and remember the last error for the runtime health surface,
   * so a misbehaving watch can't drown the loop in synchronous logging.
   */
  private handleError(error: unknown): void {
    this.errorCount++;
    this.lastErrorMessage = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    if (now - this.lastErrorLoggedAt < ERROR_LOG_THROTTLE_MS) return;
    this.lastErrorLoggedAt = now;
    log.error({ errorCount: this.errorCount }, this.lastErrorMessage);
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
   * Decide whether a present file needs ingesting, given a stat we already have.
   * The stat-only gate (path + mtime + size) means files we've absorbed cost no
   * read; a pass only means "maybe changed" — the content hash decides.
   */
  private considerStat(filePath: string, stat: fs.Stats): void {
    if (!SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;
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
        buffer = await this.deps.fsLimit.run(() => fs.promises.readFile(filePath));
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

async function isDatalessPlaceholder(filePath: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    const { stdout } = await execFileAsync("/usr/bin/stat", ["-f", "%f", filePath]);
    return (Number.parseInt(stdout.trim(), 10) & SF_DATALESS) !== 0;
  } catch {
    return false;
  }
}
