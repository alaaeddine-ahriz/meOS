import { ErrorCode, ErrorEnvelopeSchema, settings } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/settings/llm", () => {
  it("returns the LLM settings view matching the contract", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/settings/llm" });
    expect(res.statusCode).toBe(200);
    // The response shape is the contract the web client consumes — assert it parses.
    const parsed = settings.LlmSettingsSchema.safeParse(res.json());
    expect(parsed.success).toBe(true);
  });
});

describe("PUT /api/settings/llm", () => {
  it("rejects an invalid body with the VALIDATION_ERROR envelope", async () => {
    // `provider` is required and must be one of the known providers.
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/settings/llm",
      payload: { provider: "not-a-real-provider" },
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(envelope.recoverable).toBe(true);
    expect(typeof envelope.requestId).toBe("string");
  });

  it("accepts a valid local provider update and returns the settings view", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/settings/llm",
      payload: { provider: "local", model: "test-model", baseUrl: "http://localhost:1234/v1" },
    });
    expect(res.statusCode).toBe(200);
    const parsed = settings.LlmSettingsSchema.parse(res.json());
    expect(parsed.provider).toBe("local");
    expect(parsed.providers.local.model).toBe("test-model");
  });
});

describe("GET /api/settings/folders", () => {
  it("returns the watched-folder list (empty on a fresh DB)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/settings/folders" });
    expect(res.statusCode).toBe(200);
    const parsed = settings.ListFoldersResponse.parse(res.json());
    expect(parsed.folders).toEqual([]);
  });
});

describe("POST /api/settings/folders", () => {
  it("rejects a missing path with the VALIDATION_ERROR envelope", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/settings/folders",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

describe("GET /api/settings/llm/:provider/models", () => {
  it("400s with the BAD_REQUEST envelope for an unknown cloud provider", async () => {
    // Previously an ad-hoc { error } body; now the standard envelope.
    const res = await server.app.inject({ method: "GET", url: "/api/settings/llm/notreal/models" });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.BAD_REQUEST);
    expect(typeof envelope.requestId).toBe("string");
  });
});

describe("DELETE /api/settings/folders/:id", () => {
  it("404s with the NOT_FOUND envelope for an unknown folder id", async () => {
    const res = await server.app.inject({ method: "DELETE", url: "/api/settings/folders/999999" });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("400s with the VALIDATION_ERROR envelope for a non-numeric id", async () => {
    const res = await server.app.inject({
      method: "DELETE",
      url: "/api/settings/folders/not-a-number",
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});
