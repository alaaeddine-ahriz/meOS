import { z } from "zod";
import {
  EntitySummarySchema,
  GraphLinkSchema,
  GraphNodeSchema,
  SourceRefSchema,
} from "./common.js";

/** GET /api/wiki */
export const ListEntitiesResponse = z.object({ entities: z.array(EntitySummarySchema) });

/** GET /api/wiki/graph */
export const WikiGraphResponse = z.object({
  nodes: z.array(GraphNodeSchema),
  links: z.array(GraphLinkSchema),
});

/** GET /api/wiki/:slug */
export const WikiPageParams = z.object({ slug: z.string().min(1) });

export const WikiObservationSchema = z.object({
  text: z.string(),
  confidence: z.number(),
  tier: z.string(),
  recordedAt: z.string(),
  lastConfirmedAt: z.string(),
  /** Date (+ stale/upcoming/until marker) — the recency tag shown to the user. */
  when: z.string(),
  /** True when unconfirmed past its kind's freshness horizon. */
  stale: z.boolean(),
  /**
   * Set (#16) when this fact's only backing source revision is no longer current:
   * `superseded` (a newer version of the document replaced it), `deleted` (the
   * source was explicitly removed), or `missing` (the watched file vanished).
   * Absent when the fact is backed by the source's active revision.
   */
  sourceStatus: z.enum(["superseded", "deleted", "missing"]).nullable().optional(),
});

export const WikiRelationshipSchema = z.object({
  label: z.string(),
  direction: z.enum(["in", "out"]),
  other: z.string(),
});

export const WikiPageResponse = z.object({
  entity: EntitySummarySchema.extend({ stale: z.boolean() }),
  markdown: z.string().nullable(),
  relationships: z.array(WikiRelationshipSchema),
  sources: z.array(SourceRefSchema),
  observations: z.array(WikiObservationSchema),
});

/** GET /api/entities/duplicates */
export const DuplicateProposalSchema = z.object({
  aId: z.number(),
  bId: z.number(),
  aName: z.string(),
  bName: z.string(),
  type: z.string(),
  reasons: z.array(z.string()),
  score: z.number(),
  suggestedWinnerId: z.number(),
});
export const DuplicatesResponse = z.object({ duplicates: z.array(DuplicateProposalSchema) });

/** POST /api/entities/merge */
export const MergeEntitiesBody = z.object({
  loserId: z.number(),
  winnerId: z.number(),
});
export const MergeEntitiesResponse = z.object({ merged: z.boolean() });

/** POST /api/entities/dismiss-duplicate */
export const DismissDuplicateBody = z.object({
  aId: z.number(),
  bId: z.number(),
});
export const DismissDuplicateResponse = z.object({ dismissed: z.boolean() });

/** POST /api/jobs/backfill-wiki */
export const BackfillWikiResponse = z.object({ started: z.boolean() });

export type WikiPage = z.infer<typeof WikiPageResponse>;
export type WikiGraph = z.infer<typeof WikiGraphResponse>;
export type DuplicateProposal = z.infer<typeof DuplicateProposalSchema>;
