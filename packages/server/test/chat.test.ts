import { chat, ErrorCode, ErrorEnvelopeSchema } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/conversations", () => {
  it("returns the conversation list matching the contract", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/conversations" });
    expect(res.statusCode).toBe(200);
    const parsed = chat.ListConversationsResponse.parse(res.json());
    expect(Array.isArray(parsed.conversations)).toBe(true);
  });
});

describe("POST /api/conversations", () => {
  it("creates a conversation and returns its id", async () => {
    const res = await server.app.inject({ method: "POST", url: "/api/conversations" });
    expect(res.statusCode).toBe(201);
    const parsed = chat.CreateConversationResponse.parse(res.json());
    expect(typeof parsed.id).toBe("number");
  });
});

describe("GET /api/conversations/:id/messages", () => {
  it("returns messages for an existing conversation", async () => {
    const created = chat.CreateConversationResponse.parse(
      (await server.app.inject({ method: "POST", url: "/api/conversations" })).json(),
    );
    const res = await server.app.inject({
      method: "GET",
      url: `/api/conversations/${created.id}/messages`,
    });
    expect(res.statusCode).toBe(200);
    const parsed = chat.MessagesResponse.parse(res.json());
    expect(Array.isArray(parsed.messages)).toBe(true);
  });

  it("400s with the VALIDATION_ERROR envelope for a non-numeric id", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/conversations/not-a-number/messages",
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("404s with the NOT_FOUND envelope for an unknown conversation", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/conversations/987654/messages" });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("GET /api/search", () => {
  it("400s with the VALIDATION_ERROR envelope when q is missing", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/search" });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});
