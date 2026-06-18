import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JobQueue,
  KnowledgeStore,
  openDatabase,
  type IngestionPipeline,
  type MeosDatabase,
} from "@meos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../src/context.js";
import { DurableIngest } from "../src/durable-ingest.js";
import { resolveSplitRole, type WorkerBridge } from "../src/runtime/process-split.js";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

/**
 * Process isolation (#94): the app process serves the UI and only enqueues, while
 * a forked worker host runs the heavy workers against the same SQLite. These
 * tests cover the split's seams WITHOUT spawning a real OS process: role
 * resolution, role-gated worker registration + producer-only enqueue, the
 * cross-connection executor (a worker draining jobs another connection wrote),
 * and the cross-process health surface.
 */
describe("resolveSplitRole", () => {
  it("is single-process by default and opt-in via MEOS_WORKER_PROCESS", () => {
    expect(resolveSplitRole({})).toBe("all");
    expect(resolveSplitRole({ MEOS_WORKER_PROCESS: "1" })).toBe("app");
  });

  it("honors MEOS_IN_PROCESS_WORKERS=1 as a hard kill switch", () => {
    expect(resolveSplitRole({ MEOS_WORKER_PROCESS: "1", MEOS_IN_PROCESS_WORKERS: "1" })).toBe(
      "all",
    );
  });
});

describe("role-gated context wiring", () => {
  let rootDir: string;
  const contexts: AppContext[] = [];
  const prevDataDir = process.env.MEOS_DATA_DIR;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-split-"));
    const dataDir = path.join(rootDir, "data");
    fs.writeFileSync(
      path.join(rootDir, "meos.config.json"),
      JSON.stringify({
        dataDir,
        embedding: { provider: "hash", model: "hash" },
        llm: { provider: "local", local: { baseUrl: "http://localhost:1234/v1", model: "t" } },
      }),
    );
    process.env.MEOS_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) {
      try {
        await ctx.workers.stopAll();
      } catch {
        /* never started */
      }
      try {
        ctx.db.close();
      } catch {
        /* already closed */
      }
    }
    if (prevDataDir === undefined) delete process.env.MEOS_DATA_DIR;
    else process.env.MEOS_DATA_DIR = prevDataDir;
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  /** A bridge that records what the app process forwarded to the worker host. */
  function recordingBridge(): WorkerBridge & {
    pumps: number;
    events: string[];
    consolidates: number;
  } {
    const calls = { pumps: 0, events: [] as string[], consolidates: 0 };
    return {
      ...calls,
      notifyPump() {
        this.pumps++;
      },
      forwardEvent(name) {
        this.events.push(name);
      },
      forwardConnector() {},
      forwardConsolidate() {
        this.consolidates++;
      },
    };
  }

  it("app role registers only the watcher and enqueues without executing", () => {
    const bridge = recordingBridge();
    const ctx = createContext(rootDir, { role: "app", bridge });
    contexts.push(ctx);

    // The heavy workers live in the worker host; the app keeps only the watcher.
    expect(ctx.workers.list().map((w) => w.name)).toEqual(["watcher"]);

    // Enqueue is producer-only: it persists + spills + wakes the worker, but never
    // claims/executes the job itself (it stays pending here).
    const inboxItemId = ctx.store.createInboxItem("note");
    const jobId = ctx.durableIngest.enqueueText({ title: "note", text: "hello", inboxItemId });
    expect(bridge.pumps).toBe(1);
    expect(ctx.store.getIngestJob(jobId)!.state).toBe("pending");
  });

  it("worker role registers the heavy executors, not the watcher", () => {
    const ctx = createContext(rootDir, { role: "worker" });
    contexts.push(ctx);
    const names = ctx.workers.list().map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(["connectors", "ingest", "embedding", "wiki"]));
    expect(names).not.toContain("watcher");
  });

  it("'all' role (default) registers every worker, as before the split", () => {
    const ctx = createContext(rootDir);
    contexts.push(ctx);
    const names = ctx.workers.list().map((w) => w.name);
    expect(names).toEqual(
      expect.arrayContaining(["watcher", "connectors", "ingest", "embedding", "wiki"]),
    );
  });
});

describe("cross-connection executor (the worker drains what the app wrote)", () => {
  let file: string;
  let stagingDir: string;

  beforeEach(() => {
    file = path.join(os.tmpdir(), `meos-split-exec-${process.pid}-${process.hrtime.bigint()}.db`);
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-split-staging-"));
  });

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(file + suffix);
      } catch {
        /* ignore */
      }
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
  });

  it("a worker-role executor drains a job a producer connection enqueued", async () => {
    // Producer side (the app process): a separate connection persists the job +
    // spills its bytes, but runs no executor.
    const producerDb = openDatabase(file);
    const producerStore = new KnowledgeStore(producerDb);
    const jobId = producerStore.createIngestJob({
      kind: "text",
      payload: { kind: "text", title: "Pasted" },
    });
    fs.writeFileSync(path.join(stagingDir, String(jobId)), "cross-process body", "utf8");
    producerDb.close();

    // Worker side: a fresh connection to the SAME file claims + executes the job,
    // reconstructing its input from the spilled staging bytes (it never held the
    // live buffer).
    const workerDb = openDatabase(file);
    const workerStore = new KnowledgeStore(workerDb);
    let received: { title?: string; text?: string } | null = null;
    const pipeline = {
      ingest: async (input: { title?: string; text?: string }) => {
        received = input;
        return { status: "done" as const };
      },
      retryExtractionForSource: () => new Promise(() => {}),
    } as unknown as IngestionPipeline;
    const queue = new JobQueue(1);
    const executor = new DurableIngest({ store: workerStore, pipeline, queue, stagingDir });

    executor.pump();
    await queue.onIdle();

    expect(received).toEqual({ kind: "text", title: "Pasted", text: "cross-process body" });
    expect(workerStore.getIngestJob(jobId)!.state).toBe("completed");
    workerDb.close();
  });
});

describe("cross-process worker health surfaces through /api/runtime", () => {
  let server: TestServer;
  let db: MeosDatabase;

  beforeEach(async () => {
    server = await buildTestServer();
    db = server.ctx.db;
  });

  afterEach(async () => {
    await server.cleanup();
  });

  it("merges a fresh persisted worker row alongside in-process workers", async () => {
    // 'scheduler' is not registered in this (single-process test) server, so it
    // only appears if the persisted heartbeat is merged in.
    server.ctx.store.upsertWorkerHealth({
      name: "scheduler",
      status: "idle",
      detail: "next run soon",
      lastError: null,
      lastRunAt: null,
    });

    const res = await server.app.inject({ method: "GET", url: "/api/runtime" });
    expect(res.statusCode).toBe(200);
    const scheduler = res.json().workers.find((w: { name: string }) => w.name === "scheduler");
    expect(scheduler).toMatchObject({ status: "idle", detail: "next run soon" });
  });

  it("reports a stale heartbeat as an errored (down) worker", async () => {
    server.ctx.store.upsertWorkerHealth({ name: "scheduler", status: "idle", lastError: null });
    // Backdate the heartbeat well past the staleness window.
    db.prepare(
      "UPDATE worker_health SET heartbeat_at = datetime('now','-60 seconds') WHERE name = ?",
    ).run("scheduler");

    const res = await server.app.inject({ method: "GET", url: "/api/runtime" });
    const scheduler = res.json().workers.find((w: { name: string }) => w.name === "scheduler");
    expect(scheduler.status).toBe("error");
    expect(scheduler.lastError).toMatch(/heartbeat/i);
  });
});
