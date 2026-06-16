import { ErrorCode, ErrorEnvelopeSchema, git } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/settings/git", () => {
  it("returns the git status (with autoSync folded in) matching the contract", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/settings/git" });
    expect(res.statusCode).toBe(200);
    const parsed = git.GitStatusSchema.parse(res.json());
    expect(typeof parsed.autoSync).toBe("boolean");
    expect(typeof parsed.initialized).toBe("boolean");
  });
});

describe("GET /api/settings/git/commit/:hash", () => {
  it("fails with an ErrorEnvelope for a bogus commit hash", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/settings/git/commit/deadbeefdeadbeef",
    });
    // The handler wraps ctx.git.show errors in httpError.notFound; if the repo is
    // uninitialized the call still fails, just assert a 4xx + valid envelope.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("PUT /api/settings/git/remote", () => {
  it("rejects a missing url with the VALIDATION_ERROR envelope", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/settings/git/remote",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});
