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
});

export const GraphLinkSchema = z.object({
  from: z.number(),
  to: z.number(),
  label: z.string(),
});

export const OkSchema = z.object({ ok: z.boolean() });

export type EntitySummary = z.infer<typeof EntitySummarySchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphLink = z.infer<typeof GraphLinkSchema>;
