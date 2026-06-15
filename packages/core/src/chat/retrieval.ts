import type { Embedder } from "../embedding/embedder.js";
import { reciprocalRankFusion, topK } from "../embedding/vectors.js";
import {
  effectiveDate,
  type EntityRow,
  type KnowledgeStore,
  type SourceRef,
} from "../knowledge/store.js";
import { temporalTag } from "../memory/temporal.js";
import { classifyIntent, type QueryIntent } from "./query-planner.js";

export interface ContextPack {
  /** Formatted knowledge context ready to inject into the prompt. */
  text: string;
  matchedEntities: EntityRow[];
  /** Distinct source documents the context draws on. */
  sources: SourceRef[];
  /** How the planner read the query — drives how this pack was assembled. */
  intent: QueryIntent;
}

export interface RetrievalOptions {
  /** Override the planner's classification (defaults to classifyIntent(query)). */
  intent?: QueryIntent;
  /** Max raw source excerpts to include. */
  chunkCount?: number;
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
  options: RetrievalOptions = {},
): Promise<ContextPack> {
  const intent = options.intent ?? classifyIntent(query);
  // "Where did I mention X" wants raw evidence, so widen the excerpt budget.
  const chunkCount = options.chunkCount ?? (intent === "find_source" ? 12 : 6);
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

  // Graph stream (3rd retrieval signal): pull entities one hop from the directly
  // matched seeds via active edges, so "what's impacted if I change X?" surfaces
  // dependents, decisions, and risks that share no query text with X. Seeds keep
  // priority; neighbours fill the remaining section slots.
  const graphNeighbors = store.graphNeighbors(entityOrder.slice(0, 6), 8);
  for (const entityId of graphNeighbors) addEntity(entityId);

  const sections: string[] = [];
  const sources = new Map<number, SourceRef>();
  const matchedEntities: EntityRow[] = [];

  // --- compiled wiki prose (top synthesised pages) ---
  // For an entity summary, make sure the named entity's own page leads, even if
  // it wasn't the top hybrid hit.
  const wikiEntityOrder =
    intent === "summarize_entity" ? [...literalEntities.map((e) => e.id), ...wikiOrder] : wikiOrder;
  const wikiSection = [...new Set(wikiEntityOrder)]
    .slice(0, 3)
    .map((entityId) => wikiByEntity.get(entityId))
    .filter((page): page is NonNullable<typeof page> => page !== undefined)
    .map((page) => {
      for (const source of store.sourcesForEntity(page.entity_id)) sources.set(source.id, source);
      return `### Wiki: ${page.entity_name} (${page.entity_type})\n${page.body}`;
    });
  if (wikiSection.length > 0) sections.push(wikiSection.join("\n\n"));

  // --- entity graph expansion (curated facts + relationships) ---
  for (const entityId of entityOrder.slice(0, 8)) {
    const entity = store.getEntity(entityId);
    if (!entity) continue;
    matchedEntities.push(entity);
    const observations = store.activeObservations(entity.id).slice(0, 25);
    // A timeline question wants chronological order, not confidence order.
    if (intent === "trace_timeline") {
      observations.sort((a, b) => effectiveDate(a).localeCompare(effectiveDate(b)));
    }
    const relationships = store.relationshipsFor(entity.id).slice(0, 25);
    const lines = [
      `### Entity: ${entity.name} (${entity.type})`,
      entity.summary ? `Summary: ${entity.summary}` : "",
      ...observations.map((o) => {
        const source = o.source_id ? store.getSource(o.source_id) : undefined;
        if (source) sources.set(source.id, source);
        // Tag non-working tiers so the model can weight a stable, cross-source
        // "semantic" fact above a fresh "working" capture.
        const tier = o.memory_tier !== "working" ? `, ${o.memory_tier}` : "";
        // Lead every fact with its date (+ stale/upcoming marker) so the model
        // can judge whether it's still pertinent, not just how well-supported.
        return `- [${temporalTag(o)}, confidence ${o.confidence.toFixed(2)}${source ? `, source: ${source.title}` : ""}${tier}] ${o.text}`;
      }),
      ...relationships.map((r) =>
        r.from_entity === entity.id
          ? `- ${entity.name} ${r.label} ${r.to_name}`
          : `- ${r.from_name} ${r.label} ${entity.name}`,
      ),
    ].filter(Boolean);
    sections.push(lines.join("\n"));
  }

  // --- open contradictions (when that's what was asked) ---
  if (intent === "find_contradictions") {
    const named = new Set(matchedEntities.map((e) => e.name));
    const open = store
      .unresolvedContradictions()
      .filter((c) => named.size === 0 || named.has(c.entity_name));
    if (open.length > 0) {
      sections.push(
        [
          "### Open contradictions:",
          ...open.map(
            (c) =>
              `- [${c.entity_name}] "${c.text_a}" vs "${c.text_b}"${c.note ? ` (${c.note})` : ""}`,
          ),
        ].join("\n"),
      );
    }
  }

  // --- raw source excerpts (fallback, deduped against what's above) ---
  const chunkLines = ["### Relevant source excerpts:"];
  let chunksShown = 0;
  for (const chunkId of chunkOrder) {
    if (chunksShown >= chunkCount) break;
    const chunk = chunkById.get(chunkId);
    if (!chunk) continue;
    sources.set(chunk.source_id, {
      id: chunk.source_id,
      title: chunk.source_title,
      path: chunk.source_path,
    });
    chunkLines.push(`[from "${chunk.source_title}"]\n${chunk.text}`);
    chunksShown++;
  }
  if (chunksShown > 0) sections.push(chunkLines.join("\n\n"));

  return {
    text: sections.join("\n\n") || "(the knowledge base contains nothing relevant)",
    matchedEntities,
    sources: [...sources.values()],
    intent,
  };
}
