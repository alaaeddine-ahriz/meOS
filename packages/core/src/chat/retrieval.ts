import type { Embedder } from "../embedding/embedder.js";
import { reciprocalRankFusion, topK } from "../embedding/vectors.js";
import type { EntityRow, KnowledgeStore, SourceRef } from "../knowledge/store.js";

export interface ContextPack {
  /** Formatted knowledge context ready to inject into the prompt. */
  text: string;
  matchedEntities: EntityRow[];
  /** Distinct source documents the context draws on. */
  sources: SourceRef[];
}

/** Fuse a vector ranking and a BM25 ranking of the same id-space into one. */
function hybridRank(vectorIds: number[], keywordIds: number[]): number[] {
  return reciprocalRankFusion([vectorIds, keywordIds]);
}

/**
 * Hybrid retrieval over the *compiled* knowledge first, raw sources last.
 *
 * Three id-spaces — wiki pages, curated observations, and raw chunks — are each
 * ranked by vector similarity and by BM25 keyword match, fused with reciprocal
 * rank fusion. The synthesised wiki prose and high-signal facts lead the context
 * (the whole point of a compounding wiki: stop re-deriving from raw text); raw
 * source excerpts are the fallback. Entities named in the query, or owning a
 * top-ranked fact/page, are expanded one hop into the graph with confidence
 * annotations so the model can hedge.
 */
export async function buildContextPack(
  store: KnowledgeStore,
  embedder: Embedder,
  query: string,
  chunkCount = 6,
): Promise<ContextPack> {
  const [queryVector] = await embedder.embed([query], { interactive: true });
  const qv = queryVector!;

  // --- rank each id-space (vector ∪ BM25, fused) ---
  const allChunks = store.allChunks();
  const chunkById = new Map(allChunks.map((c) => [c.id, c]));
  const chunkOrder = hybridRank(
    topK(allChunks, qv, (c) => c.vector, 30).map((h) => h.item.id),
    store.chunkFtsSearch(query, 30),
  );

  const allObs = store.allActiveObservationVectors();
  const obsById = new Map(allObs.map((o) => [o.id, o]));
  const obsOrder = hybridRank(
    topK(allObs, qv, (o) => o.vector, 30).map((h) => h.item.id),
    store.observationFtsSearch(query, 30),
  );

  const allWiki = store.allWikiPageVectors();
  const wikiByEntity = new Map(allWiki.map((w) => [w.entity_id, w]));
  const wikiOrder = hybridRank(
    topK(allWiki, qv, (w) => w.vector, 10).map((h) => h.item.entity_id),
    store.wikiFtsSearch(query, 10),
  );

  // --- which entities to expand into the graph ---
  const queryLower = query.toLowerCase();
  const literalEntities = store.listEntities().filter((entity) => {
    if (queryLower.includes(entity.name.toLowerCase())) return true;
    return store.aliasesFor(entity.id).some((alias) => queryLower.includes(alias.toLowerCase()));
  });

  const entityOrder: number[] = [];
  const seenEntity = new Set<number>();
  const addEntity = (id: number) => {
    if (!seenEntity.has(id)) {
      seenEntity.add(id);
      entityOrder.push(id);
    }
  };
  for (const entity of literalEntities) addEntity(entity.id);
  for (const entityId of wikiOrder) addEntity(entityId);
  // FTS can surface ids that aren't in the embedding-filtered map (superseded or
  // un-embedded rows); only expand entities we actually have a live fact for.
  for (const obsId of obsOrder) {
    const obs = obsById.get(obsId);
    if (obs) addEntity(obs.entity_id);
  }

  const sections: string[] = [];
  const sources = new Map<number, SourceRef>();
  const matchedEntities: EntityRow[] = [];

  // --- compiled wiki prose (top synthesised pages) ---
  const wikiSection = wikiOrder
    .slice(0, 3)
    .map((entityId) => wikiByEntity.get(entityId))
    .filter((page): page is NonNullable<typeof page> => page !== undefined)
    .map((page) => {
      for (const source of store.sourcesForEntity(page.entity_id)) sources.set(source.id, source);
      return `### Wiki: ${page.entity_name} (${page.entity_type})\n${page.body}`;
    });
  if (wikiSection.length > 0) sections.push(wikiSection.join("\n\n"));

  // --- entity graph expansion (curated facts + relationships) ---
  for (const entityId of entityOrder.slice(0, 6)) {
    const entity = store.getEntity(entityId);
    if (!entity) continue;
    matchedEntities.push(entity);
    const observations = store.activeObservations(entity.id).slice(0, 25);
    const relationships = store.relationshipsFor(entity.id).slice(0, 25);
    const lines = [
      `### Entity: ${entity.name} (${entity.type})`,
      entity.summary ? `Summary: ${entity.summary}` : "",
      ...observations.map((o) => {
        const source = o.source_id ? store.getSource(o.source_id) : undefined;
        if (source) sources.set(source.id, source);
        return `- [confidence ${o.confidence.toFixed(2)}${source ? `, source: ${source.title}` : ""}] ${o.text}`;
      }),
      ...relationships.map((r) =>
        r.from_entity === entity.id ? `- ${entity.name} ${r.label} ${r.to_name}` : `- ${r.from_name} ${r.label} ${entity.name}`,
      ),
    ].filter(Boolean);
    sections.push(lines.join("\n"));
  }

  // --- raw source excerpts (fallback, deduped against what's above) ---
  const chunkLines = ["### Relevant source excerpts:"];
  let chunksShown = 0;
  for (const chunkId of chunkOrder) {
    if (chunksShown >= chunkCount) break;
    const chunk = chunkById.get(chunkId);
    if (!chunk) continue;
    sources.set(chunk.source_id, { id: chunk.source_id, title: chunk.source_title, path: chunk.source_path });
    chunkLines.push(`[from "${chunk.source_title}"]\n${chunk.text}`);
    chunksShown++;
  }
  if (chunksShown > 0) sections.push(chunkLines.join("\n\n"));

  return {
    text: sections.join("\n\n") || "(the knowledge base contains nothing relevant)",
    matchedEntities,
    sources: [...sources.values()],
  };
}
