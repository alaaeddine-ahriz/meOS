import { z } from "zod";
import { NumericIdParam } from "./common.js";

/** A single agentic wiki-maintainer run (one page regeneration). */
export const WikiRunSchema = z.object({
  id: z.number(),
  entity_id: z.number().nullable(),
  source_id: z.number().nullable(),
  name: z.string(),
  type: z.string(),
  slug: z.string().nullable(),
  status: z.enum(["running", "done", "failed"]),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});

export const WikiRunEventKindSchema = z.enum(["reasoning", "tool-call", "tool-result", "text"]);

/** One persisted step in a run's transcript. */
export const WikiRunEventSchema = z.object({
  id: z.number(),
  run_id: z.number(),
  seq: z.number(),
  kind: WikiRunEventKindSchema,
  tool_name: z.string().nullable(),
  payload: z.string(),
  created_at: z.string(),
});

/** GET /api/activity */
export const ActivityResponse = z.object({ runs: z.array(WikiRunSchema) });

/** GET /api/activity/:id/events */
export const RunEventsParams = NumericIdParam;
export const RunEventsResponse = z.object({
  run: WikiRunSchema,
  events: z.array(WikiRunEventSchema),
});

/** A live event off the Activity SSE feed (mirrors the server's ActivityStreamEvent). */
export const ActivityStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("run-start"), runId: z.number(), name: z.string(), entityType: z.string(), slug: z.string() }),
  z.object({ type: z.literal("event"), runId: z.number(), kind: WikiRunEventKindSchema, toolName: z.string().optional(), payload: z.string() }),
  z.object({ type: z.literal("run-finish"), runId: z.number(), status: z.enum(["done", "failed"]) }),
]);

export type WikiRun = z.infer<typeof WikiRunSchema>;
export type WikiRunEvent = z.infer<typeof WikiRunEventSchema>;
export type WikiRunEventKind = z.infer<typeof WikiRunEventKindSchema>;
export type ActivityEvent = z.infer<typeof ActivityStreamEventSchema>;
