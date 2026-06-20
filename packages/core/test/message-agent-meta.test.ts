import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

let store: KnowledgeStore;
let conversationId: number;

beforeEach(() => {
  store = new KnowledgeStore(openDatabase(":memory:"));
  conversationId = store.createConversation();
});

describe("saveMessageAgentMeta + listMessages", () => {
  it("round-trips a coding-agent turn's trace, telemetry, and file changes", () => {
    const id = store.addMessage(conversationId, "assistant", "Done.");
    store.saveMessageAgentMeta(id, {
      trace: [
        { kind: "reasoning", text: "thinking" },
        {
          kind: "tool",
          toolName: "Bash",
          input: { command: "ls" },
          output: "a\nb",
          isError: false,
        },
        { kind: "text", text: "Done." },
      ],
      telemetry: { costUsd: 0.012, numTurns: 3, durationMs: 4200 },
      filesChanged: [{ path: "src/a.ts", status: "modified" }],
    });

    const [message] = store.listMessages(conversationId);
    expect(message?.trace).toEqual([
      { kind: "reasoning", text: "thinking" },
      { kind: "tool", toolName: "Bash", input: { command: "ls" }, output: "a\nb", isError: false },
      { kind: "text", text: "Done." },
    ]);
    expect(message?.telemetry).toEqual({ costUsd: 0.012, numTurns: 3, durationMs: 4200 });
    expect(message?.filesChanged).toEqual([{ path: "src/a.ts", status: "modified" }]);
  });

  it("leaves plain (knowledge-chat) turns without agent metadata", () => {
    store.addMessage(conversationId, "user", "hi");
    store.addMessage(conversationId, "assistant", "hello");
    for (const message of store.listMessages(conversationId)) {
      expect(message.trace).toBeUndefined();
      expect(message.telemetry).toBeUndefined();
      expect(message.filesChanged).toBeUndefined();
    }
  });

  it("writes nothing when there is genuinely nothing to keep", () => {
    const id = store.addMessage(conversationId, "assistant", "x");
    store.saveMessageAgentMeta(id, { trace: [], filesChanged: [] });
    const [message] = store.listMessages(conversationId);
    expect(message?.trace).toBeUndefined();
    expect(message?.telemetry).toBeUndefined();
  });

  it("upserts — a second save replaces the first", () => {
    const id = store.addMessage(conversationId, "assistant", "x");
    store.saveMessageAgentMeta(id, { telemetry: { costUsd: 1, numTurns: 1, durationMs: 1 } });
    store.saveMessageAgentMeta(id, {
      trace: [{ kind: "text", text: "x" }],
      telemetry: { costUsd: 2, numTurns: 2, durationMs: 2 },
    });
    const [message] = store.listMessages(conversationId);
    expect(message?.telemetry).toEqual({ costUsd: 2, numTurns: 2, durationMs: 2 });
    expect(message?.trace).toEqual([{ kind: "text", text: "x" }]);
  });
});
