import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrations, openDatabase, type MeosDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

/**
 * The durable ingest-job ledger (#13) at the store tier: persistence, the
 * pending → processing → completed | failed → dead-letter lifecycle, bounded
 * retries with backoff, crash recovery of stale `processing` jobs, manual
 * retry, queue-depth health, and retention. The orchestration on top of these
 * primitives (DurableIngest) lives in the server package; here we exercise the
 * primitives directly so the failure/recovery transitions are deterministic.
 */
describe("durable ingest jobs (store)", () => {
  let db: MeosDatabase;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function makeStore() {
    return new KnowledgeStore(db);
  }

  it("persists a job and claims → completes it", () => {
    const store = makeStore();
    const id = store.createIngestJob({
      kind: "file",
      payload: { kind: "file", filename: "a.txt", path: "/tmp/a.txt" },
      contentHash: "abc",
      byteSize: 42,
    });
    const created = store.getIngestJob(id)!;
    expect(created.state).toBe("pending");
    expect(created.queue).toBe("extraction");
    expect(created.byte_size).toBe(42);

    const claimed = store.claimIngestJob("extraction")!;
    expect(claimed.id).toBe(id);
    expect(claimed.state).toBe("processing");
    expect(claimed.attempts).toBe(1);
    // The lease is recorded so a crash leaves the job recoverable.
    expect(store.getIngestJob(id)!.leased_at).not.toBeNull();
    // An attempt history row is opened.
    expect(store.getIngestRuns(id)).toHaveLength(1);

    store.completeIngestJob(id, "done");
    const done = store.getIngestJob(id)!;
    expect(done.state).toBe("completed");
    expect(done.leased_at).toBeNull();
    expect(store.getIngestRuns(id)[0]!.state).toBe("completed");
  });

  it("claims nothing while the only job is parked behind its backoff window", () => {
    const store = makeStore();
    const id = store.createIngestJob({ kind: "text" });
    store.claimIngestJob("extraction");
    // A failure with a long backoff pushes run_after into the future.
    store.failIngestJob(id, "boom", 60_000);
    expect(store.getIngestJob(id)!.state).toBe("pending");
    expect(store.claimIngestJob("extraction")).toBeUndefined();
  });

  it("retries a failed job up to max_attempts, then dead-letters it", () => {
    const store = makeStore();
    const id = store.createIngestJob({ kind: "text", maxAttempts: 2 });

    // Attempt 1 fails → back to pending (retryable). Even with a 0ms base the
    // backoff has a 1-second floor, so clear run_after to re-claim immediately.
    store.claimIngestJob("extraction");
    expect(store.failIngestJob(id, "fail 1", 0)).toBe("pending");
    expect(store.getIngestJob(id)!.state).toBe("pending");
    db.prepare("UPDATE ingest_jobs SET run_after = datetime('now') WHERE id = ?").run(id);

    // Attempt 2 fails → attempts now equal max_attempts → dead-letter.
    store.claimIngestJob("extraction");
    expect(store.failIngestJob(id, "fail 2", 0)).toBe("dead-letter");
    const dead = store.getIngestJob(id)!;
    expect(dead.state).toBe("dead-letter");
    expect(dead.attempts).toBe(2);
    expect(dead.last_error).toBe("fail 2");
    // Two attempts, both closed: one failed, one dead-letter.
    const runs = store.getIngestRuns(id);
    expect(runs.map((r) => r.state)).toEqual(["failed", "dead-letter"]);
  });

  it("recovers a stale `processing` job back to pending", () => {
    const store = makeStore();
    const id = store.createIngestJob({ kind: "text" });
    store.claimIngestJob("extraction");
    expect(store.getIngestJob(id)!.state).toBe("processing");

    // Startup recovery (grace 0) reclaims everything left processing.
    const recovered = store.recoverStaleIngestJobs(0);
    expect(recovered).toBe(1);
    const job = store.getIngestJob(id)!;
    expect(job.state).toBe("pending");
    expect(job.leased_at).toBeNull();
    // The interrupted attempt's run row is closed as failed.
    expect(store.getIngestRuns(id)[0]!.state).toBe("failed");
    // ...and it can be claimed again.
    expect(store.claimIngestJob("extraction")!.id).toBe(id);
  });

  it("does not reclaim a job that is still within its lease grace window", () => {
    const store = makeStore();
    store.createIngestJob({ kind: "text" });
    store.claimIngestJob("extraction");
    // A long grace means a freshly-leased job is considered in-flight, not stale.
    expect(store.recoverStaleIngestJobs(3600)).toBe(0);
  });

  it("manually retries a dead-letter job, resetting its attempt budget", () => {
    const store = makeStore();
    const id = store.createIngestJob({ kind: "text", maxAttempts: 1 });
    store.claimIngestJob("extraction");
    store.failIngestJob(id, "boom", 0);
    expect(store.getIngestJob(id)!.state).toBe("dead-letter");

    expect(store.retryIngestJob(id)).toBe(true);
    const retried = store.getIngestJob(id)!;
    expect(retried.state).toBe("pending");
    expect(retried.attempts).toBe(0);
    // A pending/processing job is not retryable.
    expect(store.retryIngestJob(id)).toBe(false);
    expect(store.retryIngestJob(999)).toBe(false);
  });

  it("reports per-queue depth and failure counts", () => {
    const store = makeStore();
    const a = store.createIngestJob({ kind: "text" }); // pending
    store.createIngestJob({ kind: "text" }); // pending
    const c = store.createIngestJob({ kind: "text", maxAttempts: 1 });
    store.createIngestJob({ kind: "embed", queue: "embedding" });

    store.claimIngestJob("extraction"); // claims a (oldest) → processing
    store.claimIngestJob("extraction"); // claims b → processing
    // Drive c to dead-letter.
    store.claimIngestJob("extraction"); // claims c
    store.failIngestJob(c, "boom", 0);

    const depths = store.ingestQueueDepths();
    const ext = depths.find((d) => d.queue === "extraction")!;
    expect(ext.processing).toBe(2);
    expect(ext.deadLetter).toBe(1);
    const emb = depths.find((d) => d.queue === "embedding")!;
    expect(emb.pending).toBe(1);
    void a;
  });

  it("prunes old completed jobs but keeps failed/dead-letter history", () => {
    const store = makeStore();
    const done = store.createIngestJob({ kind: "text" });
    store.claimIngestJob("extraction");
    store.completeIngestJob(done);
    // Age the completed job past the retention window.
    db.prepare("UPDATE ingest_jobs SET updated_at = datetime('now','-30 days') WHERE id = ?").run(
      done,
    );

    const dead = store.createIngestJob({ kind: "text", maxAttempts: 1 });
    store.claimIngestJob("extraction");
    store.failIngestJob(dead, "boom", 0);
    db.prepare("UPDATE ingest_jobs SET updated_at = datetime('now','-30 days') WHERE id = ?").run(
      dead,
    );

    const pruned = store.pruneCompletedIngestJobs(7);
    expect(pruned).toBe(1);
    expect(store.getIngestJob(done)).toBeUndefined();
    // The dead-letter job stays diagnosable + retryable.
    expect(store.getIngestJob(dead)!.state).toBe("dead-letter");
  });
});

describe("migration 21 (durable ingest jobs)", () => {
  it("migrates a v20-shape DB cleanly, preserving inbox data", () => {
    expect(migrations.length).toBe(21);

    const file = path.join(os.tmpdir(), `meos-mig21-${Date.now()}-${Math.random()}.db`);
    try {
      // Build a current-shape DB and seed an inbox row, then rewind to v20.
      const db = openDatabase(file);
      const store = new KnowledgeStore(db);
      const sourceId = store.createSource({ type: "file", title: "Legacy", content: "old text" });
      const inboxId = store.createInboxItem("legacy.txt");
      store.updateInboxItem(inboxId, "done", "all good", sourceId);

      // Drop migration-21 artifacts and restore the v20 inbox_items CHECK (no
      // 'extract-failed'), simulating a DB created before #13 shipped.
      db.pragma("foreign_keys = OFF");
      db.exec(`
        DROP TABLE IF EXISTS ingest_runs;
        DROP TABLE IF EXISTS ingest_jobs;
        CREATE TABLE inbox_items_v20 (
          id INTEGER PRIMARY KEY,
          source_id INTEGER REFERENCES sources(id),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued'
            CHECK (status IN ('queued','parsing','extracting','merging','done','failed','unsupported')),
          detail TEXT,
          path TEXT,
          revision INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO inbox_items_v20
          (id, source_id, title, status, detail, path, revision, created_at, updated_at)
          SELECT id, source_id, title, status, detail, path, revision, created_at, updated_at
          FROM inbox_items;
        DROP TABLE inbox_items;
        ALTER TABLE inbox_items_v20 RENAME TO inbox_items;
        CREATE INDEX idx_inbox_items_path ON inbox_items(path);
      `);
      db.pragma("user_version = 20");
      db.close();

      // Re-open through the real migrator: migration 21 must apply cleanly.
      const upgraded = openDatabase(file);
      expect(upgraded.pragma("user_version", { simple: true })).toBe(21);

      const upStore = new KnowledgeStore(upgraded);
      // Legacy inbox row survived.
      const inbox = upStore.listInbox();
      expect(inbox.find((i) => i.id === inboxId)?.status).toBe("done");
      // The new ingest_jobs table works...
      const jobId = upStore.createIngestJob({ kind: "file" });
      expect(upStore.getIngestJob(jobId)!.state).toBe("pending");
      // ...and the inbox CHECK was relaxed to accept the new 'extract-failed' state.
      expect(() => upStore.updateInboxItem(inboxId, "extract-failed", "searchable")).not.toThrow();
      expect(upStore.listInbox().find((i) => i.id === inboxId)?.status).toBe("extract-failed");
      upgraded.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.rmSync(file + suffix);
        } catch {
          /* ignore */
        }
      }
    }
  });
});
