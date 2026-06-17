import { z } from "zod";

/**
 * The Sources tab (#goal): every locally-indexed connector item — a contact, a
 * calendar event, a task, an email — surfaced as its own first-class entry with
 * a deep link to open the original and links to the wiki entities it connects to.
 *
 * An indexed source is just a `sources` row whose `type` names a connector kind
 * (e.g. "google:gmail"); these schemas are the read-only browse contract over
 * them — here the item itself is the entity.
 */

/** A wiki/graph entity an indexed item references (its sender, an attendee, …). */
export const IndexedEntityLinkSchema = z.object({
  id: z.number(),
  type: z.string(),
  name: z.string(),
  slug: z.string(),
  /** True when this entity has its own wiki page (so the link opens one). */
  hasPage: z.boolean(),
});

/** One locally-indexed connector item. */
export const IndexedSourceSchema = z.object({
  id: z.number(),
  /** Provider id parsed from the source type, e.g. "google". */
  provider: z.string(),
  /** Connector kind parsed from the source type, e.g. "contacts" | "gmail". */
  kind: z.string(),
  /** The raw source type, e.g. "google:gmail". */
  type: z.string(),
  title: z.string(),
  /** Deep link to open the original in the provider, when one is available. */
  link: z.string().nullable(),
  createdAt: z.string().nullable(),
  /**
   * The latest source-revision status: "active" normally, "deleted"/"missing"
   * once the upstream item is gone (still listed, shown as retired).
   */
  status: z.string().nullable(),
  /** Wiki/graph entities this item is linked to (correspondents, attendees, …). */
  linkedEntities: z.array(IndexedEntityLinkSchema),
});

/** GET /api/sources */
export const ListSourcesResponse = z.object({ sources: z.array(IndexedSourceSchema) });

/** Another indexed item this one shares an entity with (email ↔ contact, …). */
export const RelatedSourceSchema = z.object({
  id: z.number(),
  kind: z.string(),
  type: z.string(),
  title: z.string(),
  link: z.string().nullable(),
  /** The entity names through which the two items are connected. */
  via: z.array(z.string()),
});

/** GET /api/sources/:id */
export const SourceDetailResponse = IndexedSourceSchema.extend({
  /** The normalized, human-readable rendering that was indexed (and embedded). */
  content: z.string().nullable(),
  /** Other indexed items connected through a shared entity. */
  relatedSources: z.array(RelatedSourceSchema),
});

export type IndexedEntityLink = z.infer<typeof IndexedEntityLinkSchema>;
export type IndexedSource = z.infer<typeof IndexedSourceSchema>;
export type RelatedSource = z.infer<typeof RelatedSourceSchema>;
export type SourceDetail = z.infer<typeof SourceDetailResponse>;
