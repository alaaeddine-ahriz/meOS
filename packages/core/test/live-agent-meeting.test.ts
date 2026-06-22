import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCodingAgent } from "../src/coding-agent/index.js";
import { detectMeeting, MEETING_DETECTION_THRESHOLD } from "../src/ingest/meeting-detect.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import { failingFallback, meetingNoteDocument } from "./fixtures/index.js";

/**
 * LIVE (#native-agent-intelligence) — meeting detection driven by a REAL local
 * coding-agent CLI (`CodingAgentLlmClient` over Claude Code), proving the
 * `completeStructured` `meeting_detection` path works as native intelligence.
 *
 * Gated behind `MEOS_LIVE_AGENT=1` (needs the `claude` CLI installed + logged in):
 *   MEOS_LIVE_AGENT=1 pnpm --filter @meos/core exec vitest run test/live-agent-meeting.test.ts
 *
 * The fallback THROWS, and `detectMeeting` SWALLOWS an LLM error into a
 * heuristic-only result (no date/attendees). So asserting the LLM-only outputs
 * (date + attendees) is what proves the agent's own classification flowed through
 * — never the heuristic fallback, never the cloud backstop.
 */
const RUN = process.env.MEOS_LIVE_AGENT === "1";

describe.runIf(RUN)("live: meeting detection via a real coding agent", () => {
  it("classifies a clear meeting note and extracts hints through the agent (no fallback)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-live-meeting-"));
    try {
      const agent = new CodingAgentLlmClient({
        agent: getCodingAgent("claude"),
        scratchDir: tmpDir,
        fallback: failingFallback(),
      });

      const result = await detectMeeting(
        meetingNoteDocument.text,
        meetingNoteDocument.title,
        agent,
      );

      console.log("[live-agent] meeting detection:", JSON.stringify(result, null, 2));

      expect(result.isMeeting).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(MEETING_DETECTION_THRESHOLD);
      // LLM-only outputs — present ONLY if the agent's classification flowed
      // through (heuristic-only would leave these empty).
      expect(result.date).toBe("2026-03-04");
      expect(result.attendees && result.attendees.length).toBeGreaterThan(0);
      const roster = (result.attendees ?? []).join(" ").toLowerCase();
      expect(roster.includes("dana") || roster.includes("sam")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 240_000);
});
