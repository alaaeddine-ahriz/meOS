import { runtime } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/runtime", () => {
  it("returns the worker health list matching the contract", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/runtime" });
    expect(res.statusCode).toBe(200);
    const parsed = runtime.RuntimeHealthSchema.parse(res.json());

    // The context registers watcher, connectors, and the ingest + wiki queue
    // workers (the scheduler worker is added by main.ts, not the test harness).
    const names = parsed.workers.map((w) => w.name).sort();
    expect(names).toEqual(["connectors", "ingest", "watcher", "wiki"]);

    // Every worker carries a valid status enum value and a lastError field.
    for (const worker of parsed.workers) {
      expect(["idle", "running", "stopped", "error"]).toContain(worker.status);
      expect(worker.lastError === null || typeof worker.lastError === "string").toBe(true);
    }
  });
});

describe("GET /api/health", () => {
  it("still returns { ok: true, llmProvider } and now a compact workers list", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      llmProvider: string;
      workers: Array<{ name: string; status: string }>;
    };
    // The CI web-smoke depends on `ok` — it must stay present and true.
    expect(body.ok).toBe(true);
    expect(typeof body.llmProvider).toBe("string");
    expect(body.workers.length).toBeGreaterThan(0);
  });
});
