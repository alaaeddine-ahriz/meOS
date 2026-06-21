import { z } from "zod";

/**
 * Meeting notes (#26) — a trusted, citable source carrying a title, date,
 * attendees, and markdown body, auto-linked to the projects / people /
 * organisations / decisions it mentions and mined for decisions, action items,
 * risks, and open questions.
 */

/** A YYYY-MM-DD date, or empty for "unknown". */
const meetingDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "date must be YYYY-MM-DD")
  .nullable()
  .optional();

/** Shared write payload for creating and updating a meeting. */
const meetingBodyShape = {
  title: z.string().min(1),
  date: meetingDate,
  attendees: z.array(z.string()).default([]),
  content: z.string().default(""),
} as const;

/** POST /api/meetings */
export const CreateMeetingBody = z.object(meetingBodyShape);

/** PUT /api/meetings/:id */
export const UpdateMeetingBody = z.object(meetingBodyShape);

/** A row in the meeting list. */
export const MeetingSummarySchema = z.object({
  sourceId: z.number(),
  title: z.string(),
  date: z.string().nullable(),
  attendees: z.array(z.string()),
});

/** GET /api/meetings */
export const ListMeetingsResponse = z.object({ meetings: z.array(MeetingSummarySchema) });

/** One extracted structured item (decision / action item / risk / open question). */
export const MeetingObservationSchema = z.object({
  id: z.number(),
  /** Observation kind: "decision" | "task" | "risk" | "open_question" | … */
  kind: z.string(),
  text: z.string(),
  /** The entity this claim is about, for traceability. */
  entity: z.string(),
  /** The exact supporting quote from the note, when located. */
  quote: z.string().nullable(),
});

/** One auto-suggested link to an existing entity, with its "why linked" reason. */
export const MeetingLinkSchema = z.object({
  id: z.number(),
  entityId: z.number(),
  entityName: z.string(),
  entityType: z.string(),
  entitySlug: z.string(),
  rationale: z.string(),
  method: z.enum(["name", "alias", "slug"]),
  status: z.enum(["suggested", "accepted", "rejected"]),
});

/** A calendar event auto-linked to a detected meeting (#85). */
export const MeetingCalendarLinkSchema = z.object({
  sourceId: z.number(),
  title: z.string(),
  /** ISO start (date or date-time), or null when unknown. */
  start: z.string().nullable(),
});

/** GET /api/meetings/:id — the detail view payload. */
export const MeetingDetailSchema = z.object({
  sourceId: z.number(),
  title: z.string(),
  date: z.string().nullable(),
  attendees: z.array(z.string()),
  /** The original markdown body. */
  content: z.string(),
  /** How the note became a meeting: detected at ingest ('auto') or created ('manual') (#85). */
  detectionMethod: z.enum(["auto", "manual"]),
  /** Classifier confidence in [0,1] for an auto-detected meeting; null for manual (#85). */
  detectionConfidence: z.number().nullable(),
  /** A synced calendar event auto-linked to this meeting, when matched (#85). */
  calendarEvent: MeetingCalendarLinkSchema.nullable(),
  /** Decisions made in the meeting. */
  decisions: z.array(MeetingObservationSchema),
  /** Action items / follow-ups. */
  actionItems: z.array(MeetingObservationSchema),
  /** Risks / blockers raised. */
  risks: z.array(MeetingObservationSchema),
  /** Open / unresolved questions. */
  openQuestions: z.array(MeetingObservationSchema),
  /** Auto-suggested links to existing entities. */
  links: z.array(MeetingLinkSchema),
});

/** PATCH /api/meetings/:id/links/:linkId — review a suggested link. */
export const ReviewLinkBody = z.object({
  status: z.enum(["accepted", "rejected"]),
});

export const ReviewLinkResponse = z.object({ updated: z.boolean() });

export const ReprocessMeetingResponse = z.object({
  sourceId: z.number(),
  status: z.enum(["done", "indexed", "failed", "unsupported"]),
});

export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;
export type MeetingObservation = z.infer<typeof MeetingObservationSchema>;
export type MeetingLink = z.infer<typeof MeetingLinkSchema>;
export type MeetingCalendarLink = z.infer<typeof MeetingCalendarLinkSchema>;
export type MeetingDetail = z.infer<typeof MeetingDetailSchema>;
