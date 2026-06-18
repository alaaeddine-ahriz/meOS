import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Semaphore } from "@meos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DurableIngest } from "../src/durable-ingest.js";
import { FolderWatcher } from "../src/watcher.js";

/**
 * The watcher's scan path exercised with lightweight fakes — no DB, no LLM, no
 * real ingest pipeline. We assert *which* files the reconciliation scan decides
 * to enqueue: supported documents anywhere in the tree, and nothing under junk
 * dirs, dotfiles, or unsupported extensions.
 */
describe("FolderWatcher scan", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "meos-watch-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relPath: string, contents = "hello"): void {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }

  /** Build a watcher whose dependencies only record what would be ingested. */
  function makeWatcher(dataDir?: string) {
    const enqueued: string[] = [];
    const inFlight: Promise<unknown>[] = [];
    const store = {
      listWatchedFolders: () => [],
      fileNeedsIngest: () => true,
      fileContentUnchanged: () => false,
      upsertInboxItemForFile: () => ({ id: 1 }),
      recordIngestedFile: () => {},
    };
    const queue = {
      pending: 0,
      push: (job: () => Promise<void>) => {
        inFlight.push(job());
      },
    };
    const durableIngest = {
      enqueueFile: (input: { path?: string }) => {
        if (input.path) enqueued.push(path.relative(root, input.path));
        return 1;
      },
    };
    const watcher = new FolderWatcher({
      store: store as never,
      pipeline: {} as never,
      queue: queue as never,
      durableIngest: durableIngest as unknown as DurableIngest,
      fsLimit: new Semaphore(64),
      dataDir,
    });
    const settle = async () => {
      // The scan walks asynchronously and enqueues over time, so wait until the
      // enqueued set stops growing for a stable window (or a hard timeout).
      let last = -1;
      let stableTicks = 0;
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 10));
        await Promise.allSettled([...inFlight]);
        if (enqueued.length === last) {
          if (++stableTicks >= 5) break;
        } else {
          stableTicks = 0;
          last = enqueued.length;
        }
      }
      await Promise.all(inFlight);
    };
    return { watcher, enqueued, settle };
  }

  it("enqueues supported files anywhere, skips junk dirs, dotfiles, and unsupported types", async () => {
    write("notes.md");
    write("report.pdf");
    write("sub/deep/memo.txt");
    write("archive.bin"); // unsupported extension
    write("node_modules/pkg/readme.md"); // junk dir
    write(".hidden.md"); // dotfile
    write(".obsidian/config.md"); // dot-dir

    const { watcher, enqueued, settle } = makeWatcher();
    watcher.addFolder(root);
    await settle();
    await watcher.close();

    expect(enqueued.sort()).toEqual(
      ["notes.md", "report.pdf", path.join("sub", "deep", "memo.txt")].sort(),
    );
  });

  it("skips deep paths under junk/dot dirs on the live watch path, not just the scan", async () => {
    // Regression: recursive fs.watch delivers a *deep* file path directly
    // (…/node_modules/pkg/readme.md), whose basename (readme.md) hides the
    // node_modules ancestor. Matching only the basename let every file a single
    // `npm install` created slip through and flood the queue until the process
    // ran out of file descriptors (EMFILE). The scan never hits this because it
    // prunes at the directory as it descends — only the watch path does.
    write("keep.md");
    write("node_modules/pkg/readme.md"); // supported ext, but under a junk dir
    write(".obsidian/note.md"); // supported ext, but under a dot-dir

    const { watcher, enqueued, settle } = makeWatcher();
    watcher.addFolder(root);
    await settle(); // initial scan enqueues keep.md only

    // Drive the watch path the way fs.watch would — with paths relative to root.
    const w = watcher as unknown as { onRawEvent(root: string, filename: string): void };
    w.onRawEvent(root, path.join("node_modules", "pkg", "readme.md"));
    w.onRawEvent(root, path.join(".obsidian", "note.md"));
    await new Promise((r) => setTimeout(r, 350)); // past the event debounce
    await settle();
    await watcher.close();

    // The supported file outside any junk dir is enqueued; nothing under the
    // junk/dot dirs ever is. (Exact multiplicity of keep.md is left loose: a real
    // recursive fs.watch may also re-deliver it on platforms that support one.)
    expect(enqueued).toContain("keep.md");
    expect(enqueued.some((p) => p.includes("node_modules") || p.includes(".obsidian"))).toBe(false);
  });

  it("never enqueues files inside the excluded data dir", async () => {
    write("keep.md");
    write("data/wiki/page.md"); // lives under the data dir → excluded

    const { watcher, enqueued, settle } = makeWatcher(path.join(root, "data"));
    watcher.addFolder(root);
    await settle();
    await watcher.close();

    expect(enqueued).toEqual(["keep.md"]);
  });
});
