import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChatService } from "../src/chat/chat.js";
import { getCodingAgent } from "../src/coding-agent/index.js";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import { failingFallback } from "./fixtures/index.js";

/**
 * LIVE (#native-agent-intelligence) — agentic chat driven by a REAL local
 * coding-agent CLI (`CodingAgentLlmClient` over Claude Code), exercising the
 * `streamAgent` path end to end through `ChatService.respond`.
 *
 * Gated behind `MEOS_LIVE_AGENT=1` (needs the `claude` CLI installed + logged in):
 *   MEOS_LIVE_AGENT=1 pnpm --filter @meos/core exec vitest run test/live-agent-chat.test.ts
 *
 * No meOS MCP servers are wired here, so the agent answers from the prompt alone
 * (the chat persona leans on knowledge tools it doesn't have, so we do NOT assert
 * any specific answer content — only that REAL agent text streamed). The fallback
 * THROWS, so a pass means the real agent's streamed text flowed through respond as
 * delta events and the turn was persisted — which is exactly the streamAgent path.
 */
const RUN = process.env.MEOS_LIVE_AGENT === "1";

describe.runIf(RUN)("live: agentic chat via a real coding agent", () => {
  it("streams a real agent reply through ChatService.respond and persists the turn", async () => {
    const db: MeosDatabase = openDatabase(":memory:");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-live-chat-"));
    try {
      const store = new KnowledgeStore(db);
      const embedder = new HashEmbedder();
      const agent = new CodingAgentLlmClient({
        agent: getCodingAgent("claude"),
        scratchDir: tmpDir,
        fallback: failingFallback(),
      });
      const chat = new ChatService(store, agent, embedder);
      const conversationId = store.createConversation();

      let reply = "";
      let deltas = 0;
      for await (const event of chat.respond(
        conversationId,
        "Briefly introduce yourself in one sentence.",
      )) {
        if (event.type === "delta") {
          reply += event.text;
          deltas++;
        }
      }

      console.log("[live-agent] chat reply:", reply);

      // The real agent's streamed text reached the caller via delta events and was
      // persisted verbatim — the streamAgent path end to end (no fallback).
      expect(deltas).toBeGreaterThan(0);
      expect(reply.trim().length).toBeGreaterThan(0);
      const messages = store.listMessages(conversationId);
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(messages[1]!.content).toBe(reply);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 240_000);
});
