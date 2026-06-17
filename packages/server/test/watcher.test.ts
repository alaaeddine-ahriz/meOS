import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
