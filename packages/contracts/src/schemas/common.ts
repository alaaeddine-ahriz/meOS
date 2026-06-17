import { z } from "zod";

/** A numeric id passed in a URL path segment (always a string over the wire). */
export const NumericIdParam = z.object({ id: z.coerce.number().int() });

/** Shared primitives reused across route modules. */

export const EntitySummarySchema = z.object({
  id: z.number(),
  type: z.string(),
  name: z.string(),
  slug: z.string(),
  summary: z.string().nullable(),
  updatedAt: z.string(),
});

export const SourceRefSchema = z.object({
  id: z.number(),
  title: z.string(),
  path: z.string().nullable(),
  /** Origin: file/image/conversation, or a connector kind like "google:gmail". */
  type: z.string().optional(),
  /**
   * Structure-aware citation locators (#14): where in the source the cited
   * excerpt lives. All optional/back-compatible — present only when the backing
   * chunk carried the metadata, so a plain-text source still cites cleanly.
   */
  section: z.string().nullable().optional(),
  pageStart: z.number().nullable().optional(),
  pageEnd: z.number().nullable().optional(),
  charStart: z.number().nullable().optional(),
  charEnd: z.number().nullable().optional(),
});

export const GraphNodeSchema = z.object({
  id: z.number(),
  type: z.string(),
  name: z.string(),
  slug: z.string(),
  /**
   * One-line entity summary, surfaced in the graph's focus/inspect panel (#89).
   * Optional/nullable so the chat subgraph (which doesn't load summaries) and
   * any older consumer keep validating.
   */
  summary: z.string().nullable().optional(),
});

export const GraphLinkSchema = z.object({
  from: z.number(),
  to: z.number(),
  label: z.string(),
  /**
   * Edge trust (#89): the backing relationship's confidence (0–1). The client
   * scales edge opacity/width by it and hides edges below a threshold by
   * default. Optional/back-compatible — the chat subgraph omits it.
   */
  confidence: z.number().optional(),
  /** A representative source id for the edge, so the user can open the evidence (#89). */
  sourceId: z.number().nullable().optional(),
  /** How many distinct sources back this edge — drives the "confirmed" idiom. */
  sourceCount: z.number().optional(),
  /**
   * Whether the link is corroborated enough to treat as user-trustworthy rather
   * than a single-shot LLM guess (#89). NOTE: there is no user-confirmation
   * column on relationships, so this is a documented PROXY: an edge backed by
   * more than one distinct source (or pinned at the confidence cap by repeated
   * reinforcement) is rendered "confirmed" (solid); everything else is treated
   * as generated (dashed).
   */
  confirmed: z.boolean().optional(),
});

export const OkSchema = z.object({ ok: z.boolean() });

export type EntitySummary = z.infer<typeof EntitySummarySchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphLink = z.infer<typeof GraphLinkSchema>;
