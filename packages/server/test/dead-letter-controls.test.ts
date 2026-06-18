import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

/**
 * Bulk dead-letter controls (#98): the Health tab can requeue or discard the
 * whole failed pile. These drive the real routes through `app.inject` against the
 * durable layer + store.
 */
describe("dead-letter bulk controls (#98)", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
  });

  afterEach(async () => {
    await server.cleanup();
  });

  /** Seed a job and drive it to dead-letter directly through the store. */
  function seedDeadLetter(): number {
    const id = server.ctx.store.createIngestJob({ kind: "text", maxAttempts: 1 });
    server.ctx.store.claimIngestJob("extraction");
    server.ctx.store.failIngestJob(id, "boom", 0);
    expect(server.ctx.store.getIngestJob(id)!.state).toBe("dead-letter");
    return id;
  }

  it("POST /api/ingest/dead-letter/retry requeues the whole pile", async () => {
    seedDeadLetter();
    seedDeadLetter();
    const res = await server.app.inject({ method: "POST", url: "/api/ingest/dead-letter/retry" });
    expect(res.statusCode).toBe(200);
    // The count of requeued jobs is returned synchronously (before the executor
    // re-runs them), so this is the deterministic assertion; the store-level test
    // covers the pending/attempts transition.
    expect(res.json()).toEqual({ retried: 2 });
  });

  it("POST /api/ingest/dead-letter/clear deletes the jobs and their staging bytes", async () => {
    const id = seedDeadLetter();
    const staged = path.join(server.ctx.config.dataDir, "ingest-staging", String(id));
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, "spilled bytes");

    const res = await server.app.inject({ method: "POST", url: "/api/ingest/dead-letter/clear" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cleared: 1 });
    expect(server.ctx.store.getIngestJob(id)).toBeUndefined();
    expect(fs.existsSync(staged)).toBe(false);
  });

  it("returns zero counts when there is no dead-letter pile", async () => {
    const retry = await server.app.inject({ method: "POST", url: "/api/ingest/dead-letter/retry" });
    expect(retry.json()).toEqual({ retried: 0 });
    const clear = await server.app.inject({ method: "POST", url: "/api/ingest/dead-letter/clear" });
    expect(clear.json()).toEqual({ cleared: 0 });
  });
});

describe("per-job controls (#98)", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
  });

  afterEach(async () => {
    await server.cleanup();
  });

  it("POST /api/ingest/jobs/:id/cancel removes a pending job; 404 for unknown", async () => {
    const id = server.ctx.store.createIngestJob({ kind: "text" });
    const res = await server.app.inject({ method: "POST", url: `/api/ingest/jobs/${id}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: true });
    expect(server.ctx.store.getIngestJob(id)).toBeUndefined();

    const missing = await server.app.inject({
      method: "POST",
      url: "/api/ingest/jobs/9999/cancel",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("POST /api/ingest/{pause,resume} toggles the persisted flag and metrics", async () => {
    const paused = await server.app.inject({ method: "POST", url: "/api/ingest/pause" });
    expect(paused.json()).toEqual({ paused: true });
    expect(server.ctx.store.isIngestPaused()).toBe(true);
    const metrics = await server.app.inject({ method: "GET", url: "/api/ingest/metrics" });
    expect(metrics.json().paused).toBe(true);

    const resumed = await server.app.inject({ method: "POST", url: "/api/ingest/resume" });
    expect(resumed.json()).toEqual({ paused: false });
    expect(server.ctx.store.isIngestPaused()).toBe(false);
  });

  it("POST /api/ingest/sources/:id/rebuild enqueues a job for the source; 404 for unknown", async () => {
    // Pause so the enqueued rebuild job stays put instead of running the real
    // pipeline against a non-existent LLM endpoint.
    server.ctx.store.setIngestPaused(true);
    const sourceId = server.ctx.store.createSource({ type: "file", title: "Doc", content: "hi" });
    const res = await server.app.inject({
      method: "POST",
      url: `/api/ingest/sources/${sourceId}/rebuild`,
    });
    expect(res.statusCode).toBe(200);
    const jobId = res.json().jobId as number;
    expect(jobId).toBeGreaterThan(0);
    expect(server.ctx.store.getIngestJob(jobId)!.source_id).toBe(sourceId);

    const missing = await server.app.inject({
      method: "POST",
      url: "/api/ingest/sources/9999/rebuild",
    });
    expect(missing.statusCode).toBe(404);
  });
});
