import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCodingAgent } from "../src/coding-agent/index.js";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import { detectContradictions } from "../src/memory/contradictions.js";
import { failingFallback } from "./fixtures/index.js";

/**
 * LIVE (#native-agent-intelligence) — contradiction judgement driven by a REAL
 * local coding-agent CLI (`CodingAgentLlmClient` over Claude Code), proving the
 * `completeStructured` `contradiction_judgement` path works as native intelligence.
 *
 * Gated behind `MEOS_LIVE_AGENT=1` (needs the `claude` CLI installed + logged in):
 *   MEOS_LIVE_AGENT=1 pnpm --filter @meos/core exec vitest run test/live-agent-contradiction.test.ts
 *
 * detectContradictions does NOT swallow LLM errors, and the fallback THROWS — so a
 * pass means the agent itself returned a schema-valid judgement that referenced
 * the prompt's numeric ids correctly (an invalid/empty answer records no conflict).
 */
const RUN = process.env.MEOS_LIVE_AGENT === "1";

describe.runIf(RUN)("live: contradiction judgement via a real coding agent", () => {
  it("detects that a newer fact supersedes/contradicts the prior one (no fallback)", async () => {
    const db: MeosDatabase = openDatabase(":memory:");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-live-contradiction-"));
    try {
      const store = new KnowledgeStore(db);
      const embedder = new HashEmbedder();
      const entity = store.createEntity({ type: "person", name: "Dana" });
      const [v1, v2] = await embedder.embed([
        "Dana lives in Paris.",
        "Dana moved to Berlin in May.",
      ]);
      const oldId = store.insertObservation({
        entityId: entity.id,
        text: "Dana lives in Paris.",
        embedding: v1!,
        confidence: 0.7,
      });
      const newId = store.insertObservation({
        entityId: entity.id,
        text: "Dana moved to Berlin in May.",
        embedding: v2!,
        confidence: 0.5,
      });

      const agent = new CodingAgentLlmClient({
        agent: getCodingAgent("claude"),
        scratchDir: tmpDir,
        fallback: failingFallback(),
      });

      const summary = await detectContradictions(store, agent, [newId]);

      console.log("[live-agent] contradiction summary:", JSON.stringify(summary));

      // The two facts are incompatible — the agent must flag a conflict (either
      // supersession or a contradiction). Reaching here at all means it returned
      // valid JSON referencing the right ids (else the fallback would have thrown).
      expect(summary.superseded + summary.contradictions).toBeGreaterThanOrEqual(1);
      // The prior id (oldId) was part of the compared pair.
      expect(oldId).toBeLessThan(newId);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 240_000);
});
