import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectMeeting, MEETING_DETECTION_THRESHOLD } from "../src/ingest/meeting-detect.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { makeAgentClient, meetingClassification, meetingNoteDocument } from "./fixtures/index.js";

/**
 * CONTRACT (offline, ungated) — meeting detection (`detectMeeting`,
 * `completeStructured`, schema `meeting_detection`, background group) returns the
 * correct verdict through the routed client on BOTH backends.
 *
 * Detection blends a deterministic heuristic with the LLM and — crucially —
 * SWALLOWS an LLM error into a heuristic-only result so it can never break
 * ingestion. So the proof that the model's classification actually flowed through
 * is the presence of LLM-ONLY outputs: the date and the attendee roster (the
 * heuristic never produces these). A throwing fallback on the agent client makes
 * "the agent itself answered" the only way those fields can appear.
 */

const { title, text } = meetingNoteDocument;

function assertDetectedMeeting(result: Awaited<ReturnType<typeof detectMeeting>>): void {
  expect(result.isMeeting).toBe(true);
  expect(result.confidence).toBeGreaterThanOrEqual(MEETING_DETECTION_THRESHOLD);
  // LLM-only outputs — their presence proves the model classification ran (not
  // the heuristic-only fallback, which leaves date/attendees empty).
  expect(result.date).toBe("2026-03-04");
  expect(result.attendees).toEqual(["Dana Lee", "Sam Patel"]);
}

describe("meeting detection — backend parity (contract)", () => {
  it("api backend: classifies through a conforming structured client", async () => {
    const api = new StubLlmClient({
      onStructured: (request) => {
        expect(request.schemaName).toBe("meeting_detection");
        return meetingClassification;
      },
    });

    assertDetectedMeeting(await detectMeeting(text, title, api));
  });

  describe("agent backend (CodingAgentLlmClient, no CLI)", () => {
    let scratchDir: string;
    beforeEach(() => {
      scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-parity-agent-"));
    });
    afterEach(() => {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    it("classifies through the real completeStructured path (no API fallback)", async () => {
      // The scripted agent emits the classification as raw JSON; the client must
      // extract + validate it. The throwing fallback means a pass = the agent
      // produced a schema-valid verdict (and detectMeeting did not swallow an error).
      const agent = makeAgentClient(scratchDir, () => JSON.stringify(meetingClassification));

      assertDetectedMeeting(await detectMeeting(text, title, agent));
    });
  });
});
