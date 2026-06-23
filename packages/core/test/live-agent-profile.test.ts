import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCodingAgent } from "../src/coding-agent/index.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import { draftProfileFromContext } from "../src/profile/profile-assistant.js";
import type { Profile } from "../src/profile/profile-doc.js";
import { failingFallback } from "./fixtures/index.js";

/**
 * LIVE (#native-agent-intelligence) — the profile assistant driven by a REAL local
 * coding-agent CLI (`CodingAgentLlmClient` over Claude Code), proving the
 * `completeStructured` `profile_proposal` path works as native intelligence.
 *
 * Gated behind `MEOS_LIVE_AGENT=1` (needs the `claude` CLI installed + logged in):
 *   MEOS_LIVE_AGENT=1 pnpm --filter @meos/core exec vitest run test/live-agent-profile.test.ts
 *
 * The fallback THROWS, so a pass means the agent itself returned a schema-valid
 * proposal (all four sections + summary) grounded in the provided document.
 */
const RUN = process.env.MEOS_LIVE_AGENT === "1";

const emptyProfile: Profile = {
  "about-me": "",
  "work-context": "",
  "key-projects": "",
  "focus-rules": "",
};

describe.runIf(RUN)("live: profile assistant via a real coding agent", () => {
  it("drafts a grounded profile proposal from a document through the agent (no fallback)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-live-profile-"));
    try {
      const agent = new CodingAgentLlmClient({
        agent: getCodingAgent("claude"),
        scratchDir: tmpDir,
        fallback: failingFallback(),
      });

      const result = await draftProfileFromContext({
        llm: agent,
        currentProfile: emptyProfile,
        documents: [
          {
            title: "About me",
            text: "I'm Alex, a solo founder building MeOS, a local-first second brain. My focus is shipping the knowledge graph and wiki features.",
          },
        ],
      });

      console.log("[live-agent] profile proposal:", JSON.stringify(result, null, 2));

      // The agent returned a valid, grounded proposal: a summary plus at least one
      // populated section, and it picked up the project named in the document.
      expect(result.summary.length).toBeGreaterThan(0);
      const joined = Object.values(result.profile).join("\n").toLowerCase();
      expect(joined.trim().length).toBeGreaterThan(0);
      expect(joined).toContain("meos");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 240_000);
});
