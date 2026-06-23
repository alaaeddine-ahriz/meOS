import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCodingAgent } from "../src/coding-agent/index.js";
import { readImage } from "../src/extract/image.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import { StubLlmClient } from "../src/llm/stub.js";

/**
 * LIVE-family (#native-agent-intelligence) — image OCR on the agent backend.
 *
 * There is NO "real agent does OCR" path: a coding-agent CLI cannot ingest an
 * image, so the REAL production client (`CodingAgentLlmClient` wired to the actual
 * `claude` definition) delegates a multimodal `complete()` to the cloud fallback
 * BY DESIGN (design §4.1). True model OCR therefore runs on the API backend (the
 * cloud provider), which this agent-focused suite deliberately does not call.
 *
 * What this proves with the production agent definition: given an image, the real
 * client routes to the fallback and NEVER spawns the CLI (a stub fallback returns a
 * marker; getting that exact marker back means no real CLI ran — an actual spawn
 * would have produced different output). Gated for family consistency:
 *   MEOS_LIVE_AGENT=1 pnpm --filter @meos/core exec vitest run test/live-agent-image.test.ts
 */
const RUN = process.env.MEOS_LIVE_AGENT === "1";

describe.runIf(RUN)("live: image OCR delegates to the API fallback (agent cannot OCR)", () => {
  it("the real claude client routes an image complete() to the fallback without spawning the CLI", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-live-image-"));
    try {
      const marker = "## Whiteboard\n\n- Ship v1\n- Fix the login bug";
      const fallback = new StubLlmClient({ onComplete: () => marker });
      const agent = new CodingAgentLlmClient({
        agent: getCodingAgent("claude"),
        scratchDir: tmpDir,
        fallback,
      });

      const text = await readImage(agent, "board.png", {
        mediaType: "image/png",
        data: "iVBORw0KGgo=",
      });

      // The fallback's marker came back verbatim → the image was delegated, not
      // sent to a real CLI (which can't read images and would answer differently).
      expect(text).toBe(marker);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});
