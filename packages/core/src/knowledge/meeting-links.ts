import type { Extraction } from "../extract/schema.js";
import { slugify, type EntityRow, type KnowledgeStore, type MeetingLinkMethod } from "./store.js";

/**
 * A single suggested link from a meeting note to an existing knowledge entity,
 * with the "why linked" rationale the product promises (#26 / issue trust req).
 */
export interface MeetingLinkSuggestion {
  entityId: number;
  entityName: string;
  entityType: string;
  rationale: string;
  method: MeetingLinkMethod;
}

/** The entity types a meeting note links out to: projects, people, orgs, decisions. */
const LINKABLE_TYPES = new Set(["project", "person", "organisation", "decision"]);

/**
 * Suggest links from a freshly-extracted meeting note to entities that already
 * exist in the knowledge base. Self-contained by design (#17 is on a separate
 * branch and must not be imported here): a candidate name from the extraction is
 * resolved against the store using three deterministic, increasingly-lenient
 * primitives —
 *
 *   1. exact name match  (`findEntityByName`, case-insensitive, also matches an
 *      alias) → "Mentioned by name in the meeting."
 *   2. normalized slug   (`getEntityBySlug(slugify(name))`) → "Mentioned as
 *      '<name>', which normalizes to the existing '<entity>'."
 *
 * The candidate set is the union of the extraction's entity names and the
 * relationship endpoints — i.e. every named thing the extractor saw — so a known
 * project/person/org/decision the meeting talks about surfaces as a reviewable
 * link even when the extractor created a fresh (or low-relevance, ungated) row.
 *
 * Structured so it can later delegate the per-candidate resolution to #17's
 * `resolveCandidate` once both land on main: replace the body of `resolveOne`
 * with a call into the shared resolver and keep this function's contract.
 */
export function suggestMeetingLinks(
  store: KnowledgeStore,
  extraction: Extraction,
  /** The id of the meeting source itself, so it never links to itself. */
  meetingSourceId: number,
): MeetingLinkSuggestion[] {
  void meetingSourceId; // a source is not an entity; kept for forward-compat with #17.
  const byEntityId = new Map<number, MeetingLinkSuggestion>();

  const toSuggestion = (
    entity: EntityRow,
    method: MeetingLinkMethod,
    rationale: string,
  ): MeetingLinkSuggestion => ({
    entityId: entity.id,
    entityName: entity.name,
    entityType: entity.type,
    method,
    rationale,
  });

  const resolveOne = (name: string): MeetingLinkSuggestion | undefined => {
    const trimmed = name.trim();
    if (!trimmed) return undefined;

    // 1. Exact name / alias (case-insensitive).
    const byName = store.findEntityByName(trimmed);
    if (byName && LINKABLE_TYPES.has(byName.type)) {
      const viaAlias = byName.name.toLowerCase() !== trimmed.toLowerCase();
      return toSuggestion(
        byName,
        viaAlias ? "alias" : "name",
        viaAlias
          ? `The meeting mentions "${trimmed}", a known alias of ${byName.type} "${byName.name}".`
          : `The meeting mentions ${byName.type} "${byName.name}" by name.`,
      );
    }

    // 2. Normalized slug — folds casing/whitespace/accent variants.
    const bySlug = store.getEntityBySlug(slugify(trimmed));
    if (bySlug && LINKABLE_TYPES.has(bySlug.type)) {
      return toSuggestion(
        bySlug,
        "slug",
        `The meeting mentions "${trimmed}", which normalizes to existing ${bySlug.type} "${bySlug.name}".`,
      );
    }
    return undefined;
  };

  const candidates = new Set<string>();
  for (const e of extraction.entities) candidates.add(e.name);
  for (const r of extraction.relationships) {
    candidates.add(r.from);
    candidates.add(r.to);
  }

  for (const name of candidates) {
    const hit = resolveOne(name);
    // First resolution for an entity wins (exact-name beats slug, both beat
    // nothing); a later, weaker match for the same entity is ignored.
    if (hit && !byEntityId.has(hit.entityId)) byEntityId.set(hit.entityId, hit);
  }

  return [...byEntityId.values()];
}
