import { ErrorCode, ErrorEnvelopeSchema, ingest, staleFacts } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/inbox", () => {
  it("returns the inbox matching the contract (empty on a fresh DB)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/inbox" });
    expect(res.statusCode).toBe(200);
    const parsed = ingest.InboxResponse.parse(res.json());
    expect(parsed.items).toEqual([]);
    expect(typeof parsed.queuePending).toBe("number");
  });
});

describe("POST /api/ingest/upload", () => {
  it("400s with the BAD_REQUEST envelope when no files are sent", async () => {
    // A multipart request with no file parts is a bad upload request.
    const res = await server.app.inject({
      method: "POST",
      url: "/api/ingest/upload",
      headers: { "content-type": "multipart/form-data; boundary=----meostest" },
      payload: "------meostest--\r\n",
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.BAD_REQUEST);
  });
});

describe("durable ingest jobs (#13)", () => {
  it("GET /api/ingest/jobs returns the persisted job ledger matching the contract", async () => {
    const { store } = server.ctx;
    const jobId = store.createIngestJob({
      kind: "file",
      payload: { kind: "file", filename: "ledger.txt" },
      contentHash: "deadbeef",
      byteSize: 12,
    });

    const res = await server.app.inject({ method: "GET", url: "/api/ingest/jobs" });
    expect(res.statusCode).toBe(200);
    const parsed = ingest.IngestJobsResponse.parse(res.json());
    const job = parsed.jobs.find((j) => j.id === jobId)!;
    expect(job).toBeDefined();
    expect(job.state).toBe("pending");
    expect(job.queue).toBe("extraction");
  });

  it("POST /api/ingest/jobs/:id/retry requeues a dead-letter job", async () => {
    const { store } = server.ctx;
    const jobId = store.createIngestJob({ kind: "text", maxAttempts: 1 });
    // claimIngestJob takes the oldest pending job on the queue; drain any earlier
    // stragglers left pending by previous cases until we hold this job (attempts→1).
    let claimed = store.claimIngestJob("extraction");
    while (claimed && claimed.id !== jobId) claimed = store.claimIngestJob("extraction");
    expect(claimed?.id).toBe(jobId);
    store.failIngestJob(jobId, "boom");
    expect(store.getIngestJob(jobId)!.state).toBe("dead-letter");

    const res = await server.app.inject({
      method: "POST",
      url: `/api/ingest/jobs/${jobId}/retry`,
    });
    expect(res.statusCode).toBe(200);
    expect(ingest.RetryJobResponse.parse(res.json()).retried).toBe(true);
    expect(store.getIngestJob(jobId)!.state).toBe("pending");
  });

  it("404s with the NOT_FOUND envelope retrying an unknown job", async () => {
    const res = await server.app.inject({ method: "POST", url: "/api/ingest/jobs/999999/retry" });
    expect(res.statusCode).toBe(404);
    expect(ErrorEnvelopeSchema.parse(res.json()).code).toBe(ErrorCode.NOT_FOUND);
  });

  it("GET /api/ingest/metrics returns the observability envelope/shape (#18)", async () => {
    const { store } = server.ctx;
    // Seed a completed run and a dead-lettered one so the aggregates are non-trivial.
    const ok = store.createIngestJob({ kind: "file" });
    let claimed = store.claimIngestJob("extraction");
    while (claimed && claimed.id !== ok) claimed = store.claimIngestJob("extraction");
    store.completeIngestJob(ok);

    const dead = store.createIngestJob({ kind: "file", maxAttempts: 1 });
    claimed = store.claimIngestJob("extraction");
    while (claimed && claimed.id !== dead) claimed = store.claimIngestJob("extraction");
    store.failIngestJob(dead, "boom", 0);

    const res = await server.app.inject({ method: "GET", url: "/api/ingest/metrics" });
    expect(res.statusCode).toBe(200);
    const parsed = ingest.IngestMetricsResponse.parse(res.json());

    // The extraction queue surfaces backlog + throughput counters.
    const ext = parsed.queues.find((q) => q.queue === "extraction");
    expect(ext).toBeDefined();
    expect(ext!.completed).toBeGreaterThanOrEqual(1);
    // Per-stage aggregation has at least the terminal outcomes we drove.
    expect(parsed.stages.reduce((s, r) => s + r.completed, 0)).toBeGreaterThanOrEqual(1);
    expect(parsed.recovery.deadLettered).toBeGreaterThanOrEqual(1);
    // The active backpressure cap is reported.
    expect(parsed.backpressure.maxBatchesPerPump).toBeGreaterThan(0);
    expect(typeof parsed.generatedAt).toBe("string");
  });

  it("400s with the BAD_REQUEST envelope retrying a job that is not retryable", async () => {
    const { store } = server.ctx;
    // A fresh pending job has nothing to retry.
    const jobId = store.createIngestJob({ kind: "text" });
    const res = await server.app.inject({
      method: "POST",
      url: `/api/ingest/jobs/${jobId}/retry`,
    });
    expect(res.statusCode).toBe(400);
    expect(ErrorEnvelopeSchema.parse(res.json()).code).toBe(ErrorCode.BAD_REQUEST);
  });
});

describe("GET /api/sources/:id/diff", () => {
  it("404s with the NOT_FOUND envelope for an unknown source id", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/sources/999999/diff" });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("400s with the VALIDATION_ERROR envelope for a non-numeric source id", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/sources/not-a-number/diff" });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

describe("GET /api/facts/stale", () => {
  it("returns facts backed only by an obsolete source revision (#16)", async () => {
    const { store } = server.ctx;
    // Seed a source whose revision is then superseded, leaving its fact stale.
    const sourceId = store.createSource({ type: "text", title: "Doc", content: "body" });
    const rev1 = store.createSourceRevision({ sourceId, normalizedContent: "v1" });
    const entity = store.createEntity({ type: "person", name: "Grace Hopper" });
    store.insertObservation({
      entityId: entity.id,
      text: "Grace Hopper coined the term debugging.",
      sourceId,
      sourceRevisionId: rev1,
    });
    // A second revision supersedes the first; the fact now hangs off rev1.
    store.createSourceRevision({ sourceId, normalizedContent: "v2" });

    const res = await server.app.inject({ method: "GET", url: "/api/facts/stale" });
    expect(res.statusCode).toBe(200);
    const parsed = staleFacts.StaleFactsResponse.parse(res.json());
    const hit = parsed.facts.find((f) => f.entityName === "Grace Hopper");
    expect(hit).toBeDefined();
    expect(hit!.status).toBe("superseded");
    expect(hit!.text).toContain("debugging");
  });
});
