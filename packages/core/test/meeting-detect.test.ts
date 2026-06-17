import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import {
  detectMeeting,
  meetingHeuristicScore,
  MEETING_DETECTION_THRESHOLD,
} from "../src/ingest/meeting-detect.js";
import { IngestionPipeline } from "../src/ingest/pipeline.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { MEETING_SOURCE_TYPE } from "../src/knowledge/visibility.js";
import { StubLlmClient } from "../src/llm/stub.js";
import type { StructuredRequest } from "../src/llm/types.js";
import { WikiWriter } from "../src/wiki/writer.js";

// A clear meeting note — section headers, attendee roster, decisions, actions.
const MEETING_NOTE = `# Orion weekly sync

**Date:** 2026-03-04

## Attendees
- Dana Lee
- Sam Patel

## Decisions
We decided to ship Project Orion in Q3.

## Action items
- Dana will prepare the rollout plan.

## Risks
Risk: the migration could slip past Q3.`;

// An ambiguous document — a generic article with no meeting structure.
const ARTICLE = `# A short history of search engines

Search engines index the web and rank pages by relevance. Early systems relied
on keyword matching; modern ones blend lexical and semantic signals. This piece
surveys how ranking evolved and what tradeoffs each generation made.`;

// The extraction the stub returns once a meeting note is routed for extraction.
function meetingExtraction() {
  return {
    entities: [
      { name: "Project Orion", type: "project", aliases: ["Orion"], summary: "Search project." },
      { name: "Dana Lee", type: "person", aliases: ["Dana"], summary: "Engineer." },
    ],
    relationships: [{ from: "Dana Lee", to: "Project Orion", label: "works on" }],
    observations: [
      {
        entity: "Project Orion",
        claim: "The team decided to ship Project Orion in Q3.",
        kind: "decision",
        sourceQuote: "We decided to ship Project Orion in Q3.",
        validFrom: null,
        validUntil: null,
        confidence: 0.9,
        sensitivity: "normal",
      },
      {
        entity: "Dana Lee",
        claim: "Dana Lee will prepare the rollout plan.",
        kind: "task",
        sourceQuote: "Dana will prepare the rollout plan.",
        validFrom: null,
        validUntil: null,
        confidence: 0.8,
        sensitivity: "normal",
      },
    ],
  };
}

/** A stub whose detection verdict is scripted, and whose extraction is canned. */
function makeLlm(detection: {
  isMeeting: boolean;
  confidence: number;
  date?: string | null;
  attendees?: string[];
}) {
  return new StubLlmClient({
    onStructured: (request: StructuredRequest<unknown>) => {
      if (request.schemaName === "meeting_detection") return detection;
      if (request.schemaName === "knowledge_extraction") return meetingExtraction();
      throw new Error(`unexpected structured request: ${request.schemaName}`);
    },
  });
}

describe("meeting heuristic (#85)", () => {
  it("scores a structured meeting note high and an article ~zero", () => {
    expect(meetingHeuristicScore(MEETING_NOTE, "Orion weekly sync")).toBeGreaterThan(0.5);
    expect(meetingHeuristicScore(ARTICLE, "A short history of search engines")).toBeLessThan(0.2);
  });
});

describe("detectMeeting (#85)", () => {
  it("does not classify a near-zero-signal doc, and skips the LLM", async () => {
    const llm = makeLlm({ isMeeting: true, confidence: 0.99 });
    const result = await detectMeeting(ARTICLE, "A short history of search engines", llm);
    expect(result.isMeeting).toBe(false);
    // Heuristic floor not cleared → no LLM call made.
    expect(llm.requests).toHaveLength(0);
  });

  it("classifies a clear meeting note above the threshold and pulls hints", async () => {
    const llm = makeLlm({
      isMeeting: true,
      confidence: 0.95,
      date: "2026-03-04",
      attendees: ["Dana Lee", "Sam Patel"],
    });
    const result = await detectMeeting(MEETING_NOTE, "Orion weekly sync", llm);
    expect(result.isMeeting).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(MEETING_DETECTION_THRESHOLD);
    expect(result.date).toBe("2026-03-04");
    expect(result.attendees).toEqual(["Dana Lee", "Sam Patel"]);
  });

  it("does not classify when the LLM says it is not a meeting", async () => {
    const llm = makeLlm({ isMeeting: false, confidence: 0.0 });
    const result = await detectMeeting(MEETING_NOTE, "Orion weekly sync", llm);
    expect(result.isMeeting).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it("degrades gracefully with no LLM (heuristic-only)", async () => {
    const result = await detectMeeting(MEETING_NOTE, "Orion weekly sync");
    // Heuristic alone may or may not clear the bar, but it must never throw and
    // the score must be in range.
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

describe("pipeline meeting auto-detection (#85)", () => {
  let db: MeosDatabase;
  let tmpDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-detect-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePipeline(
    detection: {
      isMeeting: boolean;
      confidence: number;
      date?: string | null;
      attendees?: string[];
    },
    opts?: { detectMeetings?: boolean },
  ) {
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const llm = makeLlm(detection);
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({
      store,
      llm,
      embedder,
      wiki,
      detectMeetings: opts?.detectMeetings,
    });
    return { store, embedder, pipeline };
  }

  it("(a) auto-detects a clear meeting note and stores structured meeting knowledge", async () => {
    const { store, pipeline } = makePipeline({
      isMeeting: true,
      confidence: 0.95,
      date: "2026-03-04",
      attendees: ["Dana Lee", "Sam Patel"],
    });
    const outcome = await pipeline.ingest({
      kind: "text",
      title: "Orion weekly sync",
      text: MEETING_NOTE,
    });
    expect(outcome.status).toBe("done");
    const sourceId = outcome.sourceId!;

    // Routed into the meeting subsystem: meeting source type + structured row.
    expect(store.getSourceType(sourceId)).toBe(MEETING_SOURCE_TYPE);
    const note = store.getMeetingNote(sourceId);
    expect(note?.detection_method).toBe("auto");
    expect(note?.detection_confidence).toBeGreaterThanOrEqual(MEETING_DETECTION_THRESHOLD);
    expect(note?.meeting_date).toBe("2026-03-04");
    expect(note?.attendees).toEqual(["Dana Lee", "Sam Patel"]);

    // Meeting-relevant observations + reviewable link suggestions persisted.
    const kinds = store
      .observationsForSource(sourceId)
      .map((o) => o.kind)
      .sort();
    expect(kinds).toContain("decision");
    expect(kinds).toContain("task");
    expect(store.meetingLinkSuggestions(sourceId).length).toBeGreaterThan(0);
  });

  it("(b) does NOT auto-classify an ambiguous document", async () => {
    // Even if the LLM would say yes, the heuristic floor blocks the call.
    const { store, pipeline } = makePipeline({ isMeeting: true, confidence: 0.99 });
    const outcome = await pipeline.ingest({
      kind: "text",
      title: "A short history of search engines",
      text: ARTICLE,
    });
    expect(outcome.status).toBe("done");
    const sourceId = outcome.sourceId!;
    expect(store.getSourceType(sourceId)).not.toBe(MEETING_SOURCE_TYPE);
    expect(store.getMeetingNote(sourceId)).toBeUndefined();
  });

  it("(c) preserves the original document as the citable source", async () => {
    const { store, pipeline } = makePipeline({
      isMeeting: true,
      confidence: 0.95,
      date: "2026-03-04",
      attendees: ["Dana Lee"],
    });
    const outcome = await pipeline.ingest({
      kind: "text",
      title: "Orion weekly sync",
      text: MEETING_NOTE,
    });
    const sourceId = outcome.sourceId!;
    // Content is byte-for-byte the original — detection never rewrites the source.
    expect(store.getSourceContent(sourceId)).toBe(MEETING_NOTE);
  });

  it("respects the detectMeetings=false feature guard", async () => {
    const { store, pipeline } = makePipeline(
      { isMeeting: true, confidence: 0.95 },
      { detectMeetings: false },
    );
    const outcome = await pipeline.ingest({
      kind: "text",
      title: "Orion weekly sync",
      text: MEETING_NOTE,
    });
    const sourceId = outcome.sourceId!;
    expect(store.getSourceType(sourceId)).not.toBe(MEETING_SOURCE_TYPE);
  });
});
