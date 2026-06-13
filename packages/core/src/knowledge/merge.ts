import type { Embedder } from "../embedding/embedder.js";
import { cosineSimilarity } from "../embedding/vectors.js";
import type { Extraction } from "../extract/schema.js";
import type { KnowledgeStore } from "./store.js";

/** Observations at or above this similarity to an existing active one reinforce it instead of duplicating. */
const REINFORCE_THRESHOLD = 0.9;

export interface MergeResult {
  affectedEntityIds: number[];
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
    const existing = store.findEntityByName(name);
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
    const created = store.upsertRelationship(fromId, toId, relationship.label, sourceId);
    affected.add(fromId);
    affected.add(toId);
    if (created) {
      changed.add(fromId);
      changed.add(toId);
    }
  }

  const newObservationIds: number[] = [];
  const reinforcedObservationIds: number[] = [];
  const resolvable = extraction.observations.filter((o) => resolve(o.entity) !== undefined);
  const vectors = await embedder.embed(resolvable.map((o) => o.text));

  for (let i = 0; i < resolvable.length; i++) {
    const observation = resolvable[i]!;
    const vector = vectors[i]!;
    const entityId = resolve(observation.entity)!;

    const existing = store.activeObservationVectors(entityId);
    const match = existing.find((row) => cosineSimilarity(vector, row.vector) >= REINFORCE_THRESHOLD);
    if (match) {
      store.reinforceObservation(match.id);
      reinforcedObservationIds.push(match.id);
    } else {
      newObservationIds.push(
        store.insertObservation({ entityId, text: observation.text, sourceId, embedding: vector }),
      );
      changed.add(entityId);
    }
    affected.add(entityId);
  }

  for (const id of changed) store.markWikiStale(id);

  return {
    affectedEntityIds: [...affected],
    newObservationIds,
    reinforcedObservationIds,
  };
}
