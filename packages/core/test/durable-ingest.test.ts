import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrations, openDatabase, type MeosDatabase } from "../src/db/database.js";
import { IngestPriority, KnowledgeStore } from "../src/knowledge/store.js";

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

  it("claims the highest-priority job first, FIFO within a class (#18)", () => {
    const store = makeStore();
    // Enqueue out of priority order: a watched-file job, then a user upload, then
    // another watched-file job. The user upload (higher class) must claim first,
    // then the two watched-file jobs in creation order.
    const watch1 = store.createIngestJob({ kind: "file", priority: IngestPriority.WATCH });
    const user = store.createIngestJob({ kind: "file", priority: IngestPriority.USER });
    const watch2 = store.createIngestJob({ kind: "file", priority: IngestPriority.WATCH });

    expect(store.claimIngestJob("extraction")!.id).toBe(user);
    expect(store.claimIngestJob("extraction")!.id).toBe(watch1);
    expect(store.claimIngestJob("extraction")!.id).toBe(watch2);
  });

  it("defaults a job's priority to the watched-file class (#18)", () => {
    const store = makeStore();
    const id = store.createIngestJob({ kind: "file" });
    expect(store.getIngestJob(id)!.priority).toBe(IngestPriority.WATCH);
  });

  it("aggregates per-stage timing and outcome counts from ingest_runs (#18)", () => {
    const store = makeStore();
    // A job that completes its indexing stage.
    const ok = store.createIngestJob({ kind: "file" });
    store.claimIngestJob("extraction");
    store.setIngestJobStage(ok, "indexing");
    // Re-claim is not needed; the run row carries the stage it was opened with
    // ('queued'), so drive a second job through a named stage to exercise grouping.
    store.completeIngestJob(ok, "done");

    const bad = store.createIngestJob({ kind: "file", maxAttempts: 1 });
    store.claimIngestJob("extraction");
    store.failIngestJob(bad, "boom", 0); // exhausted → dead-letter run

    const stages = store.ingestStageMetrics();
    // Every run opens against the job's current stage ('queued' here); the
    // outcomes are split across the terminal states.
    const totalCompleted = stages.reduce((s, r) => s + r.completed, 0);
    const totalDead = stages.reduce((s, r) => s + r.deadLetter, 0);
    expect(totalCompleted).toBe(1);
    expect(totalDead).toBe(1);
    for (const s of stages) {
      expect(s.avgDurationSeconds).toBeGreaterThanOrEqual(0);
      expect(s.totalDurationSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports extended queue metrics: retrying + oldest-queued + completed (#18)", () => {
    const store = makeStore();
    // One completed, one mid-retry (failed once, back to pending), one fresh.
    const done = store.createIngestJob({ kind: "file" });
    store.claimIngestJob("extraction");
    store.completeIngestJob(done);

    const retry = store.createIngestJob({ kind: "file", maxAttempts: 3 });
    store.claimIngestJob("extraction");
    store.failIngestJob(retry, "transient", 0); // back to pending, attempts=1

    store.createIngestJob({ kind: "file" }); // fresh pending, attempts=0

    const ext = store.ingestQueueMetrics().find((q) => q.queue === "extraction")!;
    expect(ext.completed).toBe(1);
    expect(ext.retrying).toBe(1); // the one that failed once and is pending again
    expect(ext.pending).toBe(2); // retry + fresh
    expect(ext.oldestQueuedAt).not.toBeNull();
  });

  it("counts stale-job recoveries and dead-letters (#18)", () => {
    const store = makeStore();
    const first = store.createIngestJob({ kind: "file" });
    store.claimIngestJob("extraction");
    // Crash recovery closes the run with the recognizable recovery error, then
    // returns the job to pending — drive it to completion so only `dead` remains
    // dead-lettered below.
    expect(store.recoverStaleIngestJobs(0)).toBe(1);
    let claimed = store.claimIngestJob("extraction");
    while (claimed && claimed.id !== first) claimed = store.claimIngestJob("extraction");
    store.completeIngestJob(first);

    const dead = store.createIngestJob({ kind: "file", maxAttempts: 1 });
    claimed = store.claimIngestJob("extraction");
    while (claimed && claimed.id !== dead) claimed = store.claimIngestJob("extraction");
    store.failIngestJob(dead, "boom", 0);

    const recovery = store.ingestRecoveryMetrics();
    expect(recovery.recovered).toBe(1);
    expect(recovery.deadLettered).toBe(1);
  });

  it("groups extraction cost telemetry by model/prompt/strategy (#18)", () => {
    const store = makeStore();
    const sourceId = store.createSource({ type: "file", title: "Doc", content: "hello" });
    const revId = store.createSourceRevision({ sourceId });
    store.putCachedExtraction(
      {
        sourceRevisionId: revId,
        contentHash: "h1",
        schemaVersion: "s1",
        promptVersion: "p1",
        modelId: "m1",
        profileVersion: "pr1",
      },
      { entities: [], relationships: [] },
      "single",
      120,
    );
    store.putCachedExtraction(
      {
        sourceRevisionId: revId,
        contentHash: "h2",
        schemaVersion: "s1",
        promptVersion: "p1",
        modelId: "m1",
        profileVersion: "pr1",
      },
      { entities: [], relationships: [] },
      "single",
      80,
    );

    // No rate table by default → cost is best-effort null, tokens summed.
    const costs = store.ingestCostMetrics();
    const group = costs.find((c) => c.modelId === "m1" && c.strategy === "single")!;
    expect(group.extractions).toBe(2);
    expect(group.tokenUsage).toBe(200);
    expect(group.estimatedCostUsd).toBeNull();

    // With a rate, cost is computed deterministically.
    const priced = store.ingestCostMetrics((m) => (m === "m1" ? 0.5 : null));
    const pricedGroup = priced.find((c) => c.modelId === "m1")!;
    expect(pricedGroup.estimatedCostUsd).toBeCloseTo((200 / 1000) * 0.5, 6);
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
    expect(migrations.length).toBe(29);

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
        DROP INDEX IF EXISTS idx_meeting_links_source;
        DROP TABLE IF EXISTS meeting_link_suggestions;
        DROP TABLE IF EXISTS meeting_notes;
        ALTER TABLE connector_items DROP COLUMN source_revision_id;
        DROP TABLE IF EXISTS extraction_cache;
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

      // Re-open through the real migrator: migration 21 (and every later one)
      // must apply cleanly, landing at the latest version.
      const upgraded = openDatabase(file);
      expect(upgraded.pragma("user_version", { simple: true })).toBe(migrations.length);

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

describe("migration 24 (ingest job priority, #18)", () => {
  it("migrates a v23-shape DB cleanly, backfilling existing jobs to the watch class", () => {
    expect(migrations.length).toBe(29);

    const file = path.join(os.tmpdir(), `meos-mig24-${Date.now()}-${Math.random()}.db`);
    try {
      // Build a current-shape DB, seed a durable job, then rewind to v23 by
      // dropping the priority column + its index (the only migration-24 artifacts).
      const db = openDatabase(file);
      const store = new KnowledgeStore(db);
      const legacyJob = store.createIngestJob({ kind: "file" });
      expect(store.getIngestJob(legacyJob)!.priority).toBe(IngestPriority.WATCH);

      db.exec(`
        DROP INDEX IF EXISTS idx_meeting_links_source;
        DROP TABLE IF EXISTS meeting_link_suggestions;
        DROP TABLE IF EXISTS meeting_notes;
        DROP INDEX IF EXISTS idx_ingest_jobs_claim;
        ALTER TABLE ingest_jobs DROP COLUMN priority;
      `);
      db.pragma("user_version = 23");
      db.close();

      // Re-open through the real migrator: migration 24 must apply cleanly and
      // backfill the pre-existing row to the watched-file default (30).
      const upgraded = openDatabase(file);
      expect(upgraded.pragma("user_version", { simple: true })).toBe(migrations.length);
      const upStore = new KnowledgeStore(upgraded);
      expect(upStore.getIngestJob(legacyJob)!.priority).toBe(IngestPriority.WATCH);

      // A new job can still set an explicit higher class, and the priority-aware
      // claim orders it ahead of the backfilled one.
      const userJob = upStore.createIngestJob({ kind: "file", priority: IngestPriority.USER });
      expect(upStore.claimIngestJob("extraction")!.id).toBe(userJob);
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

describe("migration 27 (repair inbox_items CHECK)", () => {
  it("widens the constraint on a v26 DB stuck on the old 7-value set, preserving job links", () => {
    expect(migrations.length).toBe(29);

    const file = path.join(os.tmpdir(), `meos-mig27-${Date.now()}-${Math.random()}.db`);
    try {
      // Build a current-shape DB, seed an inbox row + a durable job linked to it,
      // then simulate the migration-renumber collision: rebuild inbox_items with
      // the OLD 7-value CHECK (no 'extract-failed') while leaving user_version at
      // 26. Such a DB reached the tip version without ever getting migration 21's
      // widened constraint, so 'extract-failed' writes fail the CHECK.
      const db = openDatabase(file);
      const store = new KnowledgeStore(db);
      const sourceId = store.createSource({ type: "file", title: "Legacy", content: "old text" });
      const inboxId = store.createInboxItem("legacy.txt");
      store.updateInboxItem(inboxId, "done", "all good", sourceId);
      const jobId = store.createIngestJob({ kind: "file", inboxItemId: inboxId });

      db.pragma("foreign_keys = OFF");
      db.exec(`
        CREATE TABLE inbox_items_old (
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
        INSERT INTO inbox_items_old
          (id, source_id, title, status, detail, path, revision, created_at, updated_at)
          SELECT id, source_id, title, status, detail, path, revision, created_at, updated_at
          FROM inbox_items;
        DROP TABLE inbox_items;
        ALTER TABLE inbox_items_old RENAME TO inbox_items;
        CREATE INDEX idx_inbox_items_path ON inbox_items(path);
      `);
      db.pragma("user_version = 26");
      db.close();

      // Re-open through the real migrator: migration 27 must apply, landing at tip.
      const upgraded = openDatabase(file);
      expect(upgraded.pragma("user_version", { simple: true })).toBe(migrations.length);

      const upStore = new KnowledgeStore(upgraded);
      // The legacy inbox row survived...
      expect(upStore.listInbox().find((i) => i.id === inboxId)?.status).toBe("done");
      // ...the job→inbox link survived the rebuild's ON DELETE SET NULL...
      expect(upStore.getIngestJob(jobId)!.inbox_item_id).toBe(inboxId);
      // ...and the CHECK now accepts the previously-rejected 'extract-failed' state.
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
