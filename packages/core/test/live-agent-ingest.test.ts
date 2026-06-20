import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCodingAgent } from "../src/coding-agent/index.js";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { extractKnowledge } from "../src/extract/extractor.js";
import { IngestionPipeline } from "../src/ingest/pipeline.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import type { LlmClient } from "../src/llm/types.js";
import { WikiWriter } from "../src/wiki/writer.js";
import { adaDocument, makeEmbedder, makeExtractionStub } from "./fixtures/index.js";

/**
 * LIVE end-to-end check (#native-agent-intelligence): the app's knowledge
 * EXTRACTION driven by an actual local coding-agent CLI (`CodingAgentLlmClient`
 * over Claude Code), proving the agent works as native intelligence — not the
 * cloud API, not a stub.
 *
 * Gated behind `MEOS_LIVE_AGENT=1` (needs the `claude` CLI installed + logged in)
 * so it never runs in CI — it spawns a real CLI and uses the user's subscription:
 *   MEOS_LIVE_AGENT=1 pnpm --filter @meos/core exec vitest run test/live-agent-ingest.test.ts
 *
 * The agent's `fallback` THROWS, so a pass means the agent itself returned valid
 * schema-constrained JSON — never the cloud backstop.
 *
 * NOTE on what we assert: the RAW extraction (`extractKnowledge`), not the
 * post-merge store. The merge intentionally drops NEW low-relevance entities
 * (merge.ts) — and a faithful model, given a document unrelated to the user with
 * no profile, correctly marks it low. So "did the agent extract?" is answered by
 * the model's output, while "did ingestion run end to end?" is answered by the
 * pipeline completing. (The offline stub hardcodes high relevance, which is why
 * the offline e2e can assert on the store.)
 */
const RUN = process.env.MEOS_LIVE_AGENT === "1";

/** A fallback that must never be reached — if it is, the agent failed; fail loudly. */
const failingFallback: LlmClient = {
  complete: () => Promise.reject(new Error("fallback.complete used — agent failed")),
  completeStructured: () =>
    Promise.reject(new Error("fallback.completeStructured used — agent failed")),
  // eslint-disable-next-line require-yield
  stream: async function* () {
    throw new Error("fallback.stream used — agent failed");
  },
  runAgent: () => Promise.reject(new Error("fallback.runAgent used — agent failed")),
  // eslint-disable-next-line require-yield
  streamAgent: async function* () {
    throw new Error("fallback.streamAgent used — agent failed");
  },
};

describe.runIf(RUN)("live: knowledge extraction + ingestion via a real coding agent", () => {
  const agentLlm = (scratchDir: string) =>
    new CodingAgentLlmClient({ agent: getCodingAgent("claude"), scratchDir, fallback: failingFallback });

  it(
    "extracts structured knowledge from a document through the agent (no API fallback)",
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-live-extract-"));
      try {
        const source = {
          title: "Ada Lovelace",
          text:
            "Ada Lovelace was a 19th-century mathematician who collaborated with Charles " +
            "Babbage on the Analytical Engine. She is regarded as the first computer " +
            "programmer for writing an algorithm intended for the machine to compute " +
            "Bernoulli numbers.",
        };
        const extraction = await extractKnowledge(agentLlm(tmpDir), source);
        // eslint-disable-next-line no-console
        console.log(
          "[live-agent] extraction:",
          JSON.stringify(
            {
              entities: extraction.entities.map((e) => ({
                name: e.name,
                type: e.type,
                relevance: e.relevance,
              })),
              observations: extraction.observations.length,
              relationships: extraction.relationships.length,
            },
            null,
            2,
          ),
        );
        // The agent returned valid schema-constrained JSON (fallback never threw)
        // and actually found the people/things in the text.
        expect(extraction.entities.length).toBeGreaterThan(0);
        const names = extraction.entities.map((e) => e.name.toLowerCase());
        expect(names.some((n) => n.includes("ada") || n.includes("lovelace"))).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    240_000,
  );

  it(
    "runs the full ingestion pipeline end to end on the agent backend",
    async () => {
      const db: MeosDatabase = openDatabase(":memory:");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-live-ingest-"));
      try {
        const store = new KnowledgeStore(db);
        const embedder = makeEmbedder();
        // Wiki rewriting stays on the offline stub so the only LIVE call is the
        // pipeline's extraction (completeStructured over the agent).
        const wiki = new WikiWriter(store, makeExtractionStub(), tmpDir);
        const pipeline = new IngestionPipeline({
          store,
          llm: agentLlm(path.join(tmpDir, "scratch")),
          embedder,
          wiki,
        });
        // The pipeline drives real extraction over the agent; it must complete
        // cleanly (whether the relevance gate persists entities depends on the
        // doc/profile — see the file header — so we assert the run, not the count).
        const outcome = await pipeline.ingest(adaDocument);
        expect(outcome.status).toBe("done");
      } finally {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
