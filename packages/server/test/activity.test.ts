import { activity, ErrorCode, ErrorEnvelopeSchema } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/activity", () => {
  it("returns the run feed matching the contract (empty on a fresh DB)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/activity" });
    expect(res.statusCode).toBe(200);
    const parsed = activity.ActivityResponse.parse(res.json());
    expect(parsed.runs).toEqual([]);
  });
});

describe("GET /api/activity/:id/events", () => {
  it("404s with the NOT_FOUND envelope for an unknown run id", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/activity/999999/events" });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("400s with the VALIDATION_ERROR envelope for a non-numeric run id", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/activity/not-a-number/events",
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});
