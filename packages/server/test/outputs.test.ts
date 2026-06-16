import { ErrorCode, ErrorEnvelopeSchema, outputs } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/outputs/decision-brief", () => {
  it("returns wrapped JSON matching the contract when ?format=json", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/outputs/decision-brief?format=json",
    });
    expect(res.statusCode).toBe(200);
    const parsed = outputs.OutputJsonResponse.parse(res.json());
    expect(typeof parsed.markdown).toBe("string");
  });

  it("returns raw Markdown text without ?format=json", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/outputs/decision-brief" });
    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe("string");
    expect(res.body.length).toBeGreaterThan(0);
  });
});

describe("GET /api/outputs/timeline", () => {
  it("rejects a missing entity query with the VALIDATION_ERROR envelope", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/outputs/timeline" });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("404s with the NOT_FOUND envelope for an unknown entity", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/outputs/timeline?entity=nonexistent-entity-xyz",
    });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
  });
});
