import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCodingAgent } from "../src/coding-agent/index.js";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import type { AgentActivityChunk } from "../src/llm/types.js";
import { WikiWriter, type WikiRunSink, type WikiRunStart } from "../src/wiki/writer.js";
import { failingFallback } from "./fixtures/index.js";

/**
 * LIVE (#native-agent-intelligence) — the wiki maintainer driven by a REAL local
 * coding-agent CLI (`CodingAgentLlmClient` over Claude Code), exercising the
 * `runAgent` sandbox bridge: the agent edits files in a materialized cwd and the
 * bridge mirrors them back so WikiWriter persists the page.
 *
 * Gated behind `MEOS_LIVE_AGENT=1` (needs the `claude` CLI installed + logged in):
 *   MEOS_LIVE_AGENT=1 pnpm --filter @meos/core exec vitest run test/live-agent-wiki.test.ts
 *
 * The run sink captures the agent's activity; asserting it acted (≥1 chunk) plus a
 * created, non-empty page about the entity ties the persisted page to the real
 * agent run (not just the deterministic safety-net body).
 */
const RUN = process.env.MEOS_LIVE_AGENT === "1";

describe.runIf(RUN)("live: wiki maintainer via a real coding agent", () => {
  it("regenerates an entity page through the agent's runAgent sandbox bridge", async () => {
    const db: MeosDatabase = openDatabase(":memory:");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-live-wiki-"));
    try {
      const store = new KnowledgeStore(db);
      const entity = store.createEntity({ type: "person", name: "Ada Lovelace" });
      store.insertObservation({
        entityId: entity.id,
        text: "Ada Lovelace wrote the first published algorithm intended for a machine.",
        confidence: 0.9,
      });
      store.insertObservation({
        entityId: entity.id,
        text: "Ada Lovelace collaborated with Charles Babbage on the Analytical Engine.",
        confidence: 0.9,
      });
      store.insertObservation({
        entityId: entity.id,
        text: "Ada Lovelace was a 19th-century English mathematician.",
        confidence: 0.9,
      });

      const agent = new CodingAgentLlmClient({
        agent: getCodingAgent("claude"),
        scratchDir: path.join(tmpDir, "scratch"),
        fallback: failingFallback(),
      });

      const captured: AgentActivityChunk[] = [];
      const hook = (_start: WikiRunStart): WikiRunSink => ({
        event: (chunk) => captured.push(chunk),
        finish: () => {},
      });

      const wiki = new WikiWriter(store, agent, path.join(tmpDir, "wiki"), undefined, hook);
      const change = await wiki.regenerate(entity.id);

      const body = store.wikiPageBody(entity.id)?.body ?? "";

      console.log("[live-agent] wiki page body:\n", body);

      // A page was created, it has real prose about the entity, and the real
      // agent actually ran (the run sink captured its activity).
      expect(change?.kind).toBe("created");
      expect(body.trim().length).toBeGreaterThan(0);
      expect(body.toLowerCase()).toContain("ada");
      expect(captured.length).toBeGreaterThan(0);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 300_000);
});
