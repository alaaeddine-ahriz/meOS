import type { Embedder } from "../embedding/embedder.js";
import { topK } from "../embedding/vectors.js";
import type { EntityRow, KnowledgeStore, SourceRef } from "../knowledge/store.js";

export interface ContextPack {
  /** Formatted knowledge context ready to inject into the prompt. */
  text: string;
  matchedEntities: EntityRow[];
  /** Distinct source documents the context draws on. */
  sources: SourceRef[];
}

/**
 * Hybrid retrieval: vector search over source chunks plus graph expansion for
 * entities literally named in the query. Both views feed one context pack,
 * with confidence annotations so the model can hedge appropriately.
 */
export async function buildContextPack(
  store: KnowledgeStore,
  embedder: Embedder,
  query: string,
  chunkCount = 8,
): Promise<ContextPack> {
  const [queryVector] = await embedder.embed([query]);
  const chunkHits = topK(store.allChunks(), queryVector!, (chunk) => chunk.vector, chunkCount);

  const queryLower = query.toLowerCase();
  const matchedEntities = store.listEntities().filter((entity) => {
    if (queryLower.includes(entity.name.toLowerCase())) return true;
    return store.aliasesFor(entity.id).some((alias) => queryLower.includes(alias.toLowerCase()));
  });

  const sections: string[] = [];
  const sources = new Map<number, SourceRef>();

  for (const entity of matchedEntities.slice(0, 6)) {
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

  if (chunkHits.length > 0) {
    const lines = ["### Relevant source excerpts:"];
    for (const { item, score } of chunkHits) {
      sources.set(item.source_id, { id: item.source_id, title: item.source_title, path: item.source_path });
      lines.push(`[from "${item.source_title}", relevance ${score.toFixed(2)}]\n${item.text}`);
    }
    sections.push(lines.join("\n\n"));
  }

  return {
    text: sections.join("\n\n") || "(the knowledge base contains nothing relevant)",
    matchedEntities,
    sources: [...sources.values()],
  };
}
