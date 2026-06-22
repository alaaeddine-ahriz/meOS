import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readImage } from "../src/extract/image.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { ScriptedAgent } from "./fixtures/index.js";

/**
 * CONTRACT (offline, ungated) — image OCR (`readImage`, multimodal `complete`,
 * background group) returns correct output through the routed client on BOTH
 * backends.
 *
 * SPECIAL CASE (design §4.1): a coding-agent CLI cannot ingest an inline image, so
 * `CodingAgentLlmClient.complete()` delegates any multimodal turn to the cloud
 * `fallback` — BY DESIGN, and it must be EXPLICIT, never silent. The agent-backend
 * test therefore proves the feature delegates: a scripted agent that THROWS if it
 * is ever spawned, a fallback that returns the OCR text, and an assertion that the
 * agent was never run (prompts empty) while the fallback's text is returned. So the
 * "agent backend" works correctly = it routes images to the API, observably.
 */

const OCR = "## Receipt\n\nTotal: $42.00\nMerchant: Cafe Luna";
const image = { mediaType: "image/png", data: "iVBORw0KGgo=" };

describe("image OCR — backend parity (contract)", () => {
  it("api backend: transcribes a multimodal complete through a conforming client", async () => {
    const api = new StubLlmClient({
      onComplete: (request) => {
        // The feature must send the image as an image content part.
        const hasImage = request.messages.some(
          (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image"),
        );
        expect(hasImage).toBe(true);
        return OCR;
      },
    });

    expect(await readImage(api, "receipt.png", image)).toBe(OCR);
  });

  describe("agent backend (CodingAgentLlmClient)", () => {
    let scratchDir: string;
    beforeEach(() => {
      scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-ocr-parity-"));
    });
    afterEach(() => {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it("delegates the image to the API fallback explicitly — the CLI is never spawned", async () => {
      // If the image were NOT short-circuited, the scripted agent would run and throw.
      const scripted = new ScriptedAgent(() => {
        throw new Error("the agent CLI must not be spawned for an image complete()");
      });
      const fallback = new StubLlmClient({ onComplete: () => OCR });
      const agent = new CodingAgentLlmClient({ agent: scripted, scratchDir, fallback });

      const text = await readImage(agent, "receipt.png", image);

      // The fallback's OCR text came back...
      expect(text).toBe(OCR);
      // ...and the agent was never run — delegation was explicit, not silent.
      expect(scripted.prompts).toHaveLength(0);
    });
  });
});
