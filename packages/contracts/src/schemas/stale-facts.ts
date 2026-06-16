import { z } from "zod";

/**
 * Source-revision / stale-fact contracts (#16). A "stale-backed" fact is an
 * active observation whose only supporting source revision is no longer current —
 * superseded by a newer version of the document, or from a source that was
 * deleted or whose watched file went missing. Surfaced so the UI can flag facts
 * that came from an outdated source rather than treating them as equally current.
 */

/** The reason a fact's backing revision is no longer current. */
export const RevisionStatusSchema = z.enum(["superseded", "deleted", "missing"]);

/** One active fact backed only by an obsolete revision, with entity context. */
export const StaleFactSchema = z.object({
  id: z.number(),
  entityId: z.number(),
  entityName: z.string(),
  entitySlug: z.string(),
  text: z.string(),
  /** The worst (most obsolete) status among the revisions backing this fact. */
  status: RevisionStatusSchema,
});

/** GET /api/facts/stale */
export const StaleFactsResponse = z.object({ facts: z.array(StaleFactSchema) });

export type RevisionStatus = z.infer<typeof RevisionStatusSchema>;
export type StaleFact = z.infer<typeof StaleFactSchema>;
export type StaleFacts = z.infer<typeof StaleFactsResponse>;
