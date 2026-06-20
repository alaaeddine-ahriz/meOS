import { chat } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

// The persisted agent trace carries `z.unknown()` tool input/output through a
// discriminated union — a shape the Fastify response serializer (fast-json-
// stringify, compiled from the Zod-derived JSON schema) has to round-trip
// faithfully. This drives the real HTTP path to prove it does (the class of bug
// behind the earlier z.record serialize regression).
describe("GET /api/conversations/:id/messages — agent run metadata", () => {
  it("round-trips a coding-agent turn's trace, telemetry, and file changes over HTTP", async () => {
    const conversationId = server.ctx.store.createConversation();
    server.ctx.store.addMessage(conversationId, "user", "fix the bug");
    const assistantId = server.ctx.store.addMessage(conversationId, "assistant", "Fixed it.");
    server.ctx.store.saveMessageAgentMeta(assistantId, {
      trace: [
        { kind: "reasoning", text: "Let me look." },
        {
          kind: "tool",
          toolName: "Edit",
          input: { file_path: "a.ts", old: "x", new: "y" },
          output: { ok: true, replaced: 1 },
          isError: false,
        },
        { kind: "text", text: "Fixed it." },
      ],
      telemetry: { costUsd: 0.0123, numTurns: 4, durationMs: 5300 },
      filesChanged: [
        { path: "a.ts", status: "modified" },
        { path: "b.ts", status: "added" },
      ],
    });

    const res = await server.app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
    });
    expect(res.statusCode).toBe(200);
    // Parse against the public contract — proves the wire bytes satisfy the schema.
    const parsed = chat.MessagesResponse.parse(res.json());
    const assistant = parsed.messages.find((m) => m.role === "assistant")!;

    expect(assistant.trace).toEqual([
      { kind: "reasoning", text: "Let me look." },
      {
        kind: "tool",
        toolName: "Edit",
        input: { file_path: "a.ts", old: "x", new: "y" },
        output: { ok: true, replaced: 1 },
        isError: false,
      },
      { kind: "text", text: "Fixed it." },
    ]);
    expect(assistant.telemetry).toEqual({ costUsd: 0.0123, numTurns: 4, durationMs: 5300 });
    expect(assistant.filesChanged).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "b.ts", status: "added" },
    ]);
  });

  it("leaves a plain knowledge-chat turn with no agent metadata over HTTP", async () => {
    const conversationId = server.ctx.store.createConversation();
    server.ctx.store.addMessage(conversationId, "assistant", "hello");
    const res = await server.app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/messages`,
    });
    const parsed = chat.MessagesResponse.parse(res.json());
    const assistant = parsed.messages.find((m) => m.role === "assistant")!;
    expect(assistant.trace).toBeUndefined();
    expect(assistant.telemetry).toBeUndefined();
    expect(assistant.filesChanged).toBeUndefined();
  });
});
