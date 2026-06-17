import { suggestMeetingLinks } from "../knowledge/meeting-links.js";
import { MEETING_SOURCE_TYPE } from "../knowledge/visibility.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import type { IngestionPipeline, IngestOutcome } from "./pipeline.js";

/** The structured input for a meeting note (#26). */
export interface MeetingNoteInput {
  title: string;
  /** ISO date (YYYY-MM-DD) the meeting took place, or null/undefined if unknown. */
  date?: string | null;
  attendees?: string[];
  /** The free-form note body, markdown. */
  content: string;
}

/**
 * The extraction lens (#26) that steers the shared extractor toward what matters
 * in a meeting: decisions, action items, risks, and open questions — each mapped
 * onto an existing observation `kind` (no schema change needed). Folded into the
 * profile context for the meeting ingest only.
 */
export const MEETING_EXTRACTION_LENS = `--- MEETING NOTE LENS ---
This source is a meeting note. Extract the working substance of the meeting:
- DECISIONS the group reached → observation kind "decision".
- ACTION ITEMS / follow-ups / "who will do what" → observation kind "task".
- RISKS, blockers, or concerns raised → observation kind "risk".
- OPEN QUESTIONS / unresolved points → observation kind "open_question".
Attendees are people entities; the projects, organisations, and decisions the
meeting is about are high-relevance entities. Prefer the exact names written in
the note so they resolve to existing entities.`;

/**
 * Compose the canonical markdown body that gets stored as the meeting source's
 * content (and chunked/embedded/extracted). The structured header makes the
 * date + attendees part of the retrievable, citable text while the same fields
 * are also stored structurally on `meeting_notes` for the UI.
 */
export function composeMeetingMarkdown(input: MeetingNoteInput): string {
  const title = input.title.trim() || "Untitled meeting";
  const lines: string[] = [`# ${title}`, ""];
  if (input.date) lines.push(`**Date:** ${input.date}`);
  const attendees = (input.attendees ?? []).map((a) => a.trim()).filter(Boolean);
  if (attendees.length > 0) lines.push(`**Attendees:** ${attendees.join(", ")}`);
  if (input.date || attendees.length > 0) lines.push("");
  lines.push(input.content.trim());
  return lines.join("\n");
}

/** The synthetic path that keys a meeting's logical source for reprocess (#16). */
export function meetingSourcePath(sourceId: number): string {
  return `meeting:${sourceId}`;
}

/** The result of creating or reprocessing a meeting note. */
export interface MeetingProcessResult {
  sourceId: number;
  outcome: IngestOutcome;
}

/**
 * Run a meeting note through the full trusted-source pipeline: compose its body,
 * parse/chunk/embed/extract/merge it as a `type:"meeting"` source (so it is
 * searchable, answerable, wiki-eligible, and citable like a local file), persist
 * its structured fields, and persist auto-suggested links to existing entities.
 *
 * Reuses the standard ingestion pipeline (#13/#14/#15/#16): a meeting keyed by
 * its synthetic path ("meeting:<id>") advances the SAME logical source's
 * revision history on reprocess, superseding the prior version's facts instead
 * of forking a new source. Link suggestions are derived from the merged
 * extraction without an extra LLM call and stored for UI review.
 */
export async function processMeetingNote(
  deps: { store: KnowledgeStore; pipeline: IngestionPipeline },
  input: MeetingNoteInput,
  /** The existing meeting source id when reprocessing; omitted on create. */
  existingSourceId?: number,
): Promise<MeetingProcessResult> {
  const { store, pipeline } = deps;
  const title = input.title.trim() || "Untitled meeting";
  const markdown = composeMeetingMarkdown(input);

  let capturedSourceId = existingSourceId;
  const outcome = await pipeline.ingest({
    kind: "text",
    title,
    text: markdown,
    origin: MEETING_SOURCE_TYPE,
    // On reprocess the path is known up front, so the existing source is reused;
    // on create it's assigned after the source id exists (below).
    path: existingSourceId ? meetingSourcePath(existingSourceId) : undefined,
    extractionLens: MEETING_EXTRACTION_LENS,
    onExtraction: ({ sourceId, extraction }) => {
      capturedSourceId = sourceId;
      const suggestions = suggestMeetingLinks(store, extraction, sourceId);
      store.replaceMeetingLinkSuggestions(
        sourceId,
        suggestions.map((s) => ({
          entityId: s.entityId,
          rationale: s.rationale,
          method: s.method,
        })),
      );
    },
  });

  const sourceId = outcome.sourceId ?? capturedSourceId;
  if (sourceId === undefined) {
    throw new Error("Meeting ingest did not produce a source");
  }

  // Persist the structured fields. Title can drift from the parser's heading, so
  // pin it to the user's input. An explicit POST /api/meetings note is "manual"
  // with no detection score (#85).
  store.updateSourceTitle(sourceId, title);
  store.upsertMeetingNote({
    sourceId,
    meetingDate: input.date ?? null,
    attendees: (input.attendees ?? []).map((a) => a.trim()).filter(Boolean),
    detectionMethod: "manual",
    detectionConfidence: null,
  });
  // First-time creation: key the source by its synthetic path so future
  // reprocesses (#16) advance this same source instead of forking a new one.
  if (!existingSourceId) store.setSourcePath(sourceId, meetingSourcePath(sourceId));

  return { sourceId, outcome };
}
