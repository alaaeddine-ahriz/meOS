import { ErrorCode, ErrorEnvelopeSchema, profile } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/profile", () => {
  it("returns the profile view matching the contract", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/profile" });
    expect(res.statusCode).toBe(200);
    const parsed = profile.ProfileDataSchema.parse(res.json());
    expect(Array.isArray(parsed.sections)).toBe(true);
    expect(typeof parsed.gitSync).toBe("boolean");
  });
});

describe("GET /api/profile/:id/history", () => {
  it("404s with the NOT_FOUND envelope for an unknown section id", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/profile/not-a-real-section/history",
    });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("POST /api/profile/apply", () => {
  it("rejects a malformed body with the VALIDATION_ERROR envelope", async () => {
    // `profile` must be a record of string→string; a non-object value is invalid.
    const res = await server.app.inject({
      method: "POST",
      url: "/api/profile/apply",
      payload: { profile: "not-a-record" },
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});
