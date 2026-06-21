import { z } from "zod";
import { createLogger } from "../logger.js";
import type { LlmClient } from "../llm/types.js";

const log = createLogger("meeting-detect");

/**
 * Automatic meeting-note detection (#85). A generic file/paste is screened for
 * meeting-shape signals so it can be routed into the existing meeting subsystem
 * (#26) — structured decisions / action items / risks / open questions, link
 * suggestions, and a structured meeting row — WITHOUT a note-taking UI and
 * WITHOUT rewriting the source. Detection is two-stage and cost-aware:
 *
 *   1. a cheap deterministic HEURISTIC over the title + body (section headers
 *      like "Attendees" / "Action items" / "Decisions", date headers, name-ish
 *      bullet lists, meeting-y titles). Near-zero score → skip the LLM entirely;
 *   2. when the heuristic clears a low bar, ONE small structured LLM call refines
 *      the classification and pulls out hints (date, attendees). The two
 *      confidences are blended.
 *
 * Only a blended confidence at/above {@link MEETING_DETECTION_THRESHOLD}
 * auto-classifies — weak/ambiguous docs stay normal sources. Every failure path
 * degrades to "not a meeting" so detection can never break ingestion.
 */

/** Auto-classify a document as a meeting only at/above this blended confidence. */
export const MEETING_DETECTION_THRESHOLD = 0.7;

/**
 * The minimum heuristic score (0..1) needed to spend an LLM call. Below this the
 * document looks nothing like a meeting and we skip the LLM for cost control.
 */
export const MEETING_HEURISTIC_FLOOR = 0.2;

/** How a meeting note's structure was obtained — surfaced for trust/provenance. */
export type MeetingDetectionMethod = "auto" | "manual";

/** The outcome of running detection over a candidate document. */
export interface MeetingDetectionResult {
  /** True only when the blended confidence reached the threshold. */
  isMeeting: boolean;
  /** Blended heuristic + LLM confidence in [0,1]. */
  confidence: number;
  /** The cheap heuristic's own score, for logging/debugging. */
  heuristicScore: number;
  /** A meeting title the LLM proposed, if any (the parser's title is the default). */
  title?: string;
  /** ISO date (YYYY-MM-DD) the meeting took place, when one could be read out. */
  date?: string | null;
  /** Attendee names the LLM read out of the note, if any. */
  attendees?: string[];
}

/** The compact schema the LLM fills in to confirm/deny a meeting. */
const MeetingClassificationSchema = z.object({
  isMeeting: z.boolean(),
  confidence: z.number().min(0).max(1),
  title: z.string().optional(),
  /** YYYY-MM-DD, or null when no date is stated. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .nullable()
    .optional(),
  attendees: z.array(z.string()).optional(),
  reasoning: z.string().optional(),
});

type MeetingClassification = z.infer<typeof MeetingClassificationSchema>;

/** Section-header signals — the strongest, most meeting-specific cues. */
const HEADER_SIGNALS: Array<{ re: RegExp; weight: number }> = [
  { re: /^\s*#{0,6}\s*(attendees|present|participants)\b/imu, weight: 0.35 },
  { re: /^\s*#{0,6}\s*(action items?|action points?|todos?|to-?dos?)\b/imu, weight: 0.35 },
  { re: /^\s*#{0,6}\s*(decisions?)\b/imu, weight: 0.3 },
  { re: /^\s*#{0,6}\s*(agenda)\b/imu, weight: 0.2 },
  { re: /^\s*#{0,6}\s*(minutes)\b/imu, weight: 0.25 },
  { re: /^\s*#{0,6}\s*(next steps?|follow[- ]ups?)\b/imu, weight: 0.2 },
  { re: /^\s*#{0,6}\s*(open questions?|discussion)\b/imu, weight: 0.15 },
];

/** Inline / title signals — weaker, but cumulative. */
const INLINE_SIGNALS: Array<{ re: RegExp; weight: number }> = [
  {
    re: /\b(meeting|standup|stand-up|sync|1:1|one[- ]on[- ]one|retro(spective)?|kickoff|kick-off|review|huddle|catch[- ]up|check[- ]in)\b/imu,
    weight: 0.2,
  },
  { re: /\b(attendees?|present|participants?)\s*[:-]/imu, weight: 0.2 },
  { re: /\b(action items?|todos?|next steps?)\s*[:-]/imu, weight: 0.2 },
  { re: /\b(decided|we agreed|agreed to|will follow up|owner\s*[:-])\b/imu, weight: 0.1 },
];

/** A date header like "Date: 2026-03-04", "March 4, 2026", or "04/03/2026". */
const DATE_SIGNAL =
  /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/imu;

/** Meeting-y title words (e.g. "Weekly sync", "Orion kickoff"). */
const TITLE_SIGNAL =
  /\b(meeting|standup|stand-up|sync|1:1|retro|retrospective|kickoff|kick-off|review|huddle|notes?|minutes|agenda|weekly|daily|catch[- ]up)\b/imu;

/**
 * Score how meeting-shaped a document is from cheap text signals alone (no LLM).
 * Returns a value in [0,1]; ~0 means "nothing like a meeting" (LLM skipped).
 */
export function meetingHeuristicScore(text: string, title = ""): number {
  if (!text.trim()) return 0;
  // Cap the scan to keep this O(1)-ish on large docs — meeting cues live up top.
  const head = text.slice(0, 8000);
  let score = 0;
  for (const { re, weight } of HEADER_SIGNALS) if (re.test(head)) score += weight;
  for (const { re, weight } of INLINE_SIGNALS) if (re.test(head)) score += weight;
  if (DATE_SIGNAL.test(head)) score += 0.1;
  if (title && TITLE_SIGNAL.test(title)) score += 0.15;
  // A short bullet list of capitalised names ("- Dana Lee", "* Sam Patel") reads
  // as an attendee roster — a strong, distinctive meeting cue.
  const nameBullets = (head.match(/^\s*[-*•]\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)+\s*$/gmu) ?? []).length;
  if (nameBullets >= 2) score += 0.2;
  return Math.min(1, score);
}

/**
 * Detect whether a document is a meeting note and, if so, surface hints (date,
 * attendees) for the structured row. The LLM is OPTIONAL and fully guarded: when
 * it is omitted, returns nothing useful, or throws, detection falls back to the
 * heuristic alone (and a heuristic-only doc must clear the threshold on its own,
 * which the conservative weights make deliberately hard — so the stub/offline
 * path won't auto-classify ambiguous docs).
 */
export async function detectMeeting(
  text: string,
  title = "",
  llm?: LlmClient,
): Promise<MeetingDetectionResult> {
  const heuristicScore = meetingHeuristicScore(text, title);

  // Cost control: a document with essentially no meeting signals never reaches
  // the LLM, and is never a meeting.
  if (heuristicScore < MEETING_HEURISTIC_FLOOR) {
    return { isMeeting: false, confidence: heuristicScore, heuristicScore };
  }

  // Heuristic-only decision: require the heuristic itself to be strong. Blending
  // below would only ever lower this, so use it directly. This is the fallback
  // both when no LLM is available and when the LLM call throws.
  const heuristicOnly: MeetingDetectionResult = {
    isMeeting: heuristicScore >= MEETING_DETECTION_THRESHOLD,
    confidence: heuristicScore,
    heuristicScore,
  };
  if (!llm) return heuristicOnly;

  let classification: MeetingClassification | undefined;
  try {
    classification = await llm.completeStructured<MeetingClassification>({
      schema: MeetingClassificationSchema,
      schemaName: "meeting_detection",
      cacheSystem: true,
      system:
        "You classify whether a document is notes from a meeting (a real-time " +
        "gathering of people: standup, sync, 1:1, review, kickoff, retro, etc.). " +
        "It is a meeting note if it records who attended and/or what was discussed, " +
        "decided, or assigned. It is NOT a meeting note if it is an article, spec, " +
        "essay, email, task list with no meeting context, or general document. " +
        "Return your confidence in [0,1]. Extract the meeting title, an ISO date " +
        "(YYYY-MM-DD) if one is stated, and attendee names if listed. Be " +
        "conservative: when unsure, lower the confidence.",
      messages: [
        {
          role: "user",
          content:
            `Title: ${title || "(none)"}\n\n` + `Document (truncated):\n${text.slice(0, 6000)}`,
        },
      ],
    });
  } catch (error) {
    // The LLM is best-effort — a failure must never break ingestion. Fall back
    // to the heuristic-only decision.
    log.warn({ err: error }, "meeting detection LLM call failed; using heuristic only");
    return heuristicOnly;
  }

  // Blend: the LLM is the primary judge, the heuristic a corroborating prior.
  // When the LLM says "not a meeting", trust it — zero out the confidence so a
  // strong-looking-but-not-a-meeting doc (e.g. a planning spec) isn't misrouted.
  const llmConfidence = classification.isMeeting ? classification.confidence : 0;
  const confidence = classification.isMeeting ? 0.7 * llmConfidence + 0.3 * heuristicScore : 0;
  const isMeeting = classification.isMeeting && confidence >= MEETING_DETECTION_THRESHOLD;

  log.debug(
    {
      heuristicScore,
      llmConfidence,
      confidence,
      isMeeting,
      llmSaysMeeting: classification.isMeeting,
    },
    "meeting detection result",
  );

  return {
    isMeeting,
    confidence,
    heuristicScore,
    title: classification.title?.trim() || undefined,
    date: classification.date ?? null,
    attendees: (classification.attendees ?? []).map((a) => a.trim()).filter(Boolean),
  };
}
