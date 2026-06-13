import type { Embedder } from "../embedding/embedder.js";
import { cosineSimilarity } from "../embedding/vectors.js";
import type { Extraction } from "../extract/schema.js";
import { initialConfidence } from "../memory/confidence.js";
import { classifyMemoryTier } from "../memory/memory-tiers.js";
import { detectSensitivity, redactSecrets } from "../memory/privacy.js";
import { normalizeRelationshipLabel, strongerSensitivity } from "./schema-doc.js";
import { slugify, type KnowledgeStore } from "./store.js";

/** Observations at or above this similarity to an existing active one reinforce it instead of duplicating. */
const REINFORCE_THRESHOLD = 0.9;

/** Char span of a quote within its source text, or null when it can't be located. */
function locateQuote(sourceText: string | undefined, quote: string | null): { start: number; end: number } | null {
  if (!sourceText || !quote) return null;
  const trimmed = quote.trim();
  if (!trimmed) return null;
  const start = sourceText.indexOf(trimmed);
  return start === -1 ? null : { start, end: start + trimmed.length };
}

export interface MergeResult {
  affectedEntityIds: number[];
  /** Entities whose page content actually changed and were marked wiki-stale. */
  staleEntityIds: number[];
  newObservationIds: number[];
  reinforcedObservationIds: number[];
}

/**
 * Integrate an extraction into the knowledge base: resolve or create entities,
 * record relationships, and insert observations — reinforcing (rather than
 * duplicating) facts the system already holds.
 */
export async function mergeExtraction(
  store: KnowledgeStore,
  embedder: Embedder,
  extraction: Extraction,
  sourceId: number,
  /** The source's full text, used to locate each quote's char span (provenance). */
  sourceText?: string,
): Promise<MergeResult> {
  const entityIdByName = new Map<string, number>();
  const affected = new Set<number>();
  // Entities whose wiki page would actually read differently after this merge.
  // A page is only worth regenerating (an LLM call) when its content changes —
  // re-mentioning a known entity or merely reinforcing an existing observation
  // does not, so those are deliberately excluded.
  const changed = new Set<number>();

  const resolve = (name: string): number | undefined => {
    const key = name.trim().toLowerCase();
    if (entityIdByName.has(key)) return entityIdByName.get(key);
    // Exact name / alias first, then a slug match so whitespace, casing, and
    // accent variants of the same name fold into one entity instead of
    // fragmenting the graph (conservative: only equal-after-normalisation names).
    const existing = store.findEntityByName(name) ?? store.getEntityBySlug(slugify(name));
    if (existing) entityIdByName.set(key, existing.id);
    return existing?.id;
  };

  for (const candidate of extraction.entities) {
    let id = resolve(candidate.name);
    if (id === undefined) {
      const entity = store.createEntity({
        type: candidate.type,
        name: candidate.name,
        summary: candidate.summary || undefined,
      });
      id = entity.id;
      changed.add(id);
    }
    entityIdByName.set(candidate.name.trim().toLowerCase(), id);
    for (const alias of candidate.aliases) {
      if (alias.trim() && alias.trim().toLowerCase() !== candidate.name.trim().toLowerCase()) {
        store.addAlias(id, alias);
      }
    }
    affected.add(id);
  }

  for (const relationship of extraction.relationships) {
    const fromId = resolve(relationship.from);
    const toId = resolve(relationship.to);
    if (fromId === undefined || toId === undefined || fromId === toId) continue;
    const created = store.upsertRelationship(
      fromId,
      toId,
      normalizeRelationshipLabel(relationship.label),
      sourceId,
    );
    affected.add(fromId);
    affected.add(toId);
    if (created) {
      changed.add(fromId);
      changed.add(toId);
    }
  }

  const newObservationIds: number[] = [];
  const reinforcedObservationIds: number[] = [];
  const sourceType = store.getSourceType(sourceId);
  const resolvable = extraction.observations.filter((o) => resolve(o.entity) !== undefined);
  // Redact credentials before anything touches storage or the embedder.
  const texts = resolvable.map((o) => redactSecrets(o.claim));
  const vectors = await embedder.embed(texts);

  for (let i = 0; i < resolvable.length; i++) {
    const observation = resolvable[i]!;
    const text = texts[i]!;
    const vector = vectors[i]!;
    const entityId = resolve(observation.entity)!;

    const existing = store.activeObservationVectors(entityId);
    const match = existing.find((row) => cosineSimilarity(vector, row.vector) >= REINFORCE_THRESHOLD);
    if (match) {
      store.reinforceObservation(match.id, sourceId);
      reinforcedObservationIds.push(match.id);
    } else {
      const span = locateQuote(sourceText, observation.sourceQuote);
      newObservationIds.push(
        store.insertObservation({
          entityId,
          text,
          sourceId,
          embedding: vector,
          confidence: initialConfidence(observation.confidence, sourceType),
          kind: observation.kind,
          sourceQuote: observation.sourceQuote ? redactSecrets(observation.sourceQuote) : null,
          charStart: span?.start ?? null,
          charEnd: span?.end ?? null,
          validFrom: observation.validFrom,
          validUntil: observation.validUntil,
          // Honour the extractor's label, but a detected credential always wins.
          sensitivity: strongerSensitivity(observation.sensitivity, detectSensitivity(observation.claim)),
          // A new claim enters at its natural tier; corroboration promotes it later.
          memoryTier: classifyMemoryTier({ kind: observation.kind, sourceType, sourceCount: 1 }),
        }),
      );
      changed.add(entityId);
    }
    affected.add(entityId);
  }

  for (const id of changed) store.markWikiStale(id);

  return {
    affectedEntityIds: [...affected],
    staleEntityIds: [...changed],
    newObservationIds,
    reinforcedObservationIds,
  };
}
