import { digest, ErrorCode, ErrorEnvelopeSchema } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/contradictions", () => {
  it("returns the contradiction list matching the contract (empty on a fresh DB)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/contradictions" });
    expect(res.statusCode).toBe(200);
    const parsed = digest.ContradictionsResponse.parse(res.json());
    expect(parsed.contradictions).toEqual([]);
  });
});

describe("GET /api/audit", () => {
  it("returns the audit trail matching the contract (empty on a fresh DB)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/audit" });
    expect(res.statusCode).toBe(200);
    const parsed = digest.AuditResponse.parse(res.json());
    expect(parsed.entries).toEqual([]);
  });
});

describe("GET /api/digest/latest", () => {
  it("404s with the NOT_FOUND envelope when no digest has been generated", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/digest/latest" });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
    expect(typeof envelope.requestId).toBe("string");
  });
});

describe("POST /api/contradictions/:id/resolve", () => {
  it("rejects an invalid action body with the VALIDATION_ERROR envelope", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/contradictions/1/resolve",
      payload: { action: "not-an-action" },
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("404s with the NOT_FOUND envelope for an unknown contradiction id", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/contradictions/999999/resolve",
      payload: { action: "supersede_a" },
    });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
  });
});
