import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCodingAgent } from "../src/coding-agent/index.js";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import { crystallizeSession } from "../src/memory/crystallize.js";
import { failingFallback } from "./fixtures/index.js";

/**
 * LIVE (#native-agent-intelligence) — session crystallization driven by a REAL
 * local coding-agent CLI (`CodingAgentLlmClient` over Claude Code). Exercises the
 * back-to-back `session_digest` + `knowledge_extraction` `completeStructured` calls.
 *
 * Gated behind `MEOS_LIVE_AGENT=1` (needs the `claude` CLI installed + logged in):
 *   MEOS_LIVE_AGENT=1 pnpm --filter @meos/core exec vitest run test/live-agent-crystallize.test.ts
 *
 * The fallback THROWS and crystallizeSession does not swallow errors, so a pass
 * means the agent itself returned valid JSON for BOTH structured calls.
 */
const RUN = process.env.MEOS_LIVE_AGENT === "1";

describe.runIf(RUN)("live: session crystallization via a real coding agent", () => {
  it("distils a conversation into a session source through the agent (no fallback)", async () => {
    const db: MeosDatabase = openDatabase(":memory:");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-live-crystallize-"));
    try {
      const store = new KnowledgeStore(db);
      const convo = store.createConversation();
      store.addMessage(convo, "user", "Which backend should we use for the local-first app?");
      store.addMessage(
        convo,
        "assistant",
        "We compared options and decided to use Appwrite because it supports a local-first deployment.",
      );
      store.addMessage(convo, "user", "Great, let's go with Appwrite then.");

      const agent = new CodingAgentLlmClient({
        agent: getCodingAgent("claude"),
        scratchDir: tmpDir,
        fallback: failingFallback(),
      });

      const crystal = await crystallizeSession({
        store,
        llm: agent,
        embedder: new HashEmbedder(),
        conversationId: convo,
      });

      console.log("[live-agent] crystal digest:\n", crystal?.digest);

      // The agent produced a digest worth keeping → a first-class session source.
      expect(crystal).toBeDefined();
      expect(store.getSourceType(crystal!.sourceId)).toBe("session");
      expect(crystal!.digest.length).toBeGreaterThan(0);
      // The decision subject pervades the transcript; a faithful digest names it.
      expect(crystal!.digest.toLowerCase()).toContain("appwrite");
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 240_000);
});
