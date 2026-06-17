import { sourceHealth } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/source-health (#87)", () => {
  it("returns a well-formed aggregate on a fresh DB", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/source-health" });
    expect(res.statusCode).toBe(200);
    const parsed = sourceHealth.SourceHealthResponse.parse(res.json());

    // No folders watched and nothing connected on a fresh install.
    expect(parsed.localFolders.folders).toEqual([]);
    expect(parsed.localFolders.health).toBe("disconnected");
    expect(parsed.connectors.connected).toBe(false);
    expect(parsed.connectors.health).toBe("disconnected");
    expect(parsed.runningJobs).toEqual([]);
    expect(parsed.recentFailures).toEqual([]);
    expect(typeof parsed.generatedAt).toBe("string");
  });

  it("reflects a connected account with per-kind state", async () => {
    server.ctx.store.upsertConnectorAccount({
      provider: "google",
      clientId: "id",
      clientSecret: "secret",
      accessToken: "tok",
      refreshToken: "refresh",
    });
    const account = server.ctx.store.getConnectorAccount("google")!;
    server.ctx.store.setSyncState(account.id, "gmail", { enabled: true });

    const res = await server.app.inject({ method: "GET", url: "/api/source-health" });
    const parsed = sourceHealth.SourceHealthResponse.parse(res.json());
    expect(parsed.connectors.connected).toBe(true);
    const gmail = parsed.connectors.kinds.find((k) => k.kind === "gmail");
    expect(gmail).toBeDefined();
    expect(gmail!.enabled).toBe(true);
    // Never synced yet → idle, and the kind carries a product label.
    expect(gmail!.state).toBe("idle");
    expect(gmail!.label).toBe("Emails");
  });

  it("surfaces a dead-letter ingest job as a retryable recent failure", async () => {
    const { store } = server.ctx;
    const jobId = store.createIngestJob({ kind: "text", maxAttempts: 1 });
    let claimed = store.claimIngestJob("extraction");
    while (claimed && claimed.id !== jobId) claimed = store.claimIngestJob("extraction");
    expect(claimed?.id).toBe(jobId);
    store.failIngestJob(jobId, "boom");

    const res = await server.app.inject({ method: "GET", url: "/api/source-health" });
    const parsed = sourceHealth.SourceHealthResponse.parse(res.json());
    const failure = parsed.recentFailures.find((f) => f.id === jobId);
    expect(failure).toBeDefined();
    expect(failure!.retryable).toBe(true);
    expect(failure!.state).toBe("dead-letter");
    // The pipeline health degrades when there's a dead-letter job.
    expect(parsed.pipeline.deadLetter).toBeGreaterThan(0);
    expect(parsed.pipeline.health).toBe("degraded");
  });
});
