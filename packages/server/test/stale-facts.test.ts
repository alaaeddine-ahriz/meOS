import { ErrorCode, ErrorEnvelopeSchema, staleFacts } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/facts/stale", () => {
  it("returns the stale-fact list matching the contract (empty on a fresh DB)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/facts/stale" });
    expect(res.statusCode).toBe(200);
    const parsed = staleFacts.StaleFactsResponse.parse(res.json());
    expect(parsed.facts).toEqual([]);
  });

  it("returns the shared error envelope for an unknown facts route", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/facts/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
    expect(envelope.recoverable).toBe(false);
  });
});
