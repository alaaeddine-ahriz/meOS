import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractKnowledge } from "../src/extract/extractor.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { adaDocument, adaExtraction, makeAgentClient } from "./fixtures/index.js";

/**
 * CONTRACT (offline, ungated) — knowledge extraction (`extractKnowledge`,
 * `completeStructured`, background group) returns correct output through the
 * routed client on BOTH intelligence backends:
 *
 *  - **api**   — a conforming structured client (the cloud `AiSdkClient`'s
 *    offline stand-in, {@link StubLlmClient}); proves the method-path wiring.
 *  - **agent** — the REAL {@link makeAgentClient} (`CodingAgentLlmClient`) over a
 *    scripted in-process agent, no CLI spawn. Exercises the actual
 *    schema-in-prompt → extract-JSON → `schema.parse` path, with a fallback that
 *    throws so a pass means the AGENT produced the structured output, not the
 *    cloud backstop.
 *
 * The LIVE counterpart (real Claude CLI) is `live-agent-ingest.test.ts`.
 */

const source = { title: adaDocument.title, text: adaDocument.text };

/** The feature did its job: it found Ada and the relationship to the engine. */
function assertExtractedAda(extraction: Awaited<ReturnType<typeof extractKnowledge>>): void {
  const names = extraction.entities.map((e) => e.name.toLowerCase());
  expect(names.some((n) => n.includes("ada"))).toBe(true);
  expect(extraction.relationships.length).toBeGreaterThan(0);
  expect(extraction.observations.length).toBeGreaterThan(0);
}

describe("knowledge extraction — backend parity (contract)", () => {
  it("api backend: extracts through a conforming structured client", async () => {
    const api = new StubLlmClient({
      onStructured: (request) => {
        // The feature must call completeStructured with its real schema name.
        expect(request.schemaName).toBe("knowledge_extraction");
        return adaExtraction;
      },
    });

    assertExtractedAda(await extractKnowledge(api, source));
  });

  describe("agent backend (CodingAgentLlmClient, no CLI)", () => {
    let scratchDir: string;
    beforeEach(() => {
      scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-parity-agent-"));
    });
    afterEach(() => {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it("extracts through the real completeStructured path (no API fallback)", async () => {
      // The scripted agent emits the extraction as raw JSON. The client must
      // extract + validate it itself; the throwing fallback guarantees a pass
      // means the agent's own JSON satisfied the schema.
      const agent = makeAgentClient(scratchDir, () => JSON.stringify(adaExtraction));

      assertExtractedAda(await extractKnowledge(agent, source));
    });

    it("recovers when the agent wraps its JSON in a ```json fence + prose", async () => {
      // A real CLI often answers conversationally; extractJson must still recover.
      const agent = makeAgentClient(
        scratchDir,
        () =>
          `Sure, here is the extraction:\n\n\`\`\`json\n${JSON.stringify(adaExtraction)}\n\`\`\``,
      );

      assertExtractedAda(await extractKnowledge(agent, source));
    });
  });
});
