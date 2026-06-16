import type { Embedder } from "../embedding/embedder.js";
import { cosineSimilarity } from "../embedding/vectors.js";
import type { Extraction } from "../extract/schema.js";
import { initialConfidence } from "../memory/confidence.js";
import { classifyMemoryTier } from "../memory/memory-tiers.js";
import { detectSensitivity, redactSecrets } from "../memory/privacy.js";
import { resolveCandidate } from "./entity-resolution.js";
import { normalizeRelationshipLabel, strongerSensitivity } from "./schema-doc.js";
import { slugify, type KnowledgeStore } from "./store.js";

/** Observations at or above this similarity to an existing active one reinforce it instead of duplicating. */
const REINFORCE_THRESHOLD = 0.9;

/** Case-insensitive comparison key for two names. */
function foldKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Char span of a quote within its source text, or null when it can't be located. */
function locateQuote(
  sourceText: string | undefined,
  quote: string | null,
): { start: number; end: number } | null {
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
  /**
   * The exact source revision (#16) this extraction came from. Threaded onto
   * every observation/relationship it creates or reinforces, so a claim can be
   * traced to — and flagged the moment of — the version that produced it.
   */
  sourceRevisionId?: number,
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

  // Candidate vectors for the embedding-similarity resolution signal: embed each
  // entity's summary once so resolveCandidate can compare against an existing
  // entity's observation vectors. Names without a summary get no vector (the
  // nominal/contact signals still apply).
  const entitySummaries = extraction.entities.map((e) => e.summary || e.name);
  const entityVectors = await embedder.embed(entitySummaries);
  // Pairs the user has already rejected — never re-queue them for review.
  const dismissed = store.dismissedDuplicateKeys();

  for (let i = 0; i < extraction.entities.length; i++) {
    const candidate = extraction.entities[i]!;
    let id = resolve(candidate.name);
    if (id === undefined) {
      // Candidate generation before creating: the name may be an existing entity
      // written differently (accent, abbreviation, org suffix, alias/codename,
      // or shared email/domain). A high-confidence match folds in; an ambiguous
      // one still creates a fresh entity but is surfaced through the human-gated
      // duplicates review (findDuplicateEntities) rather than merged silently.
      const decision = resolveCandidate(
        store,
        { name: candidate.name, type: candidate.type, aliases: candidate.aliases },
        { vector: entityVectors[i], dismissed },
      );
      if (decision?.action === "merge") {
        id = decision.entity.id;
        // The extracted surface form becomes an alias so it resolves directly
        // next time without re-running candidate generation.
        if (foldKey(candidate.name) !== foldKey(decision.entity.name)) {
          store.addAlias(decision.entity.id, candidate.name);
        }
      } else {
        // Relevance gate (profile lens): a brand-new entity the extractor judged
        // only loosely relevant to the user is not promoted into the graph — it
        // would just become a generic encyclopedia page. Existing entities are
        // still reinforced below; only the creation of new low-relevance ones is
        // suppressed.
        if (candidate.relevance === "low") continue;
        const entity = store.createEntity({
          type: candidate.type,
          name: candidate.name,
          summary: candidate.summary || undefined,
        });
        id = entity.id;
        changed.add(id);
        // An ambiguous match is left for review: the new entity exists, and
        // findDuplicateEntities will surface the pair (name/contact overlap) on
        // the duplicates screen for a human to merge or dismiss.
      }
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
      sourceRevisionId,
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
    const match = existing.find(
      (row) => cosineSimilarity(vector, row.vector) >= REINFORCE_THRESHOLD,
    );
    if (match) {
      store.reinforceObservation(match.id, sourceId, sourceRevisionId);
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
          sensitivity: strongerSensitivity(
            observation.sensitivity,
            detectSensitivity(observation.claim),
          ),
          // A new claim enters at its natural tier; corroboration promotes it later.
          memoryTier: classifyMemoryTier({ kind: observation.kind, sourceType, sourceCount: 1 }),
          sourceRevisionId,
        }),
      );
      changed.add(entityId);
    }
    affected.add(entityId);
  }

  // A wiki page is only ever generated from wiki-eligible sources. Connector data
  // (contacts/calendar/gmail) complements existing pages as a reference — it never
  // triggers a regeneration, and never gives a connector-only person a page. The
  // entities/observations/relationships above are still merged (searchable); only
  // the page is suppressed. Chips are read live from sourcesForEntity, so they
  // need no stale flag. `staleEntityIds` reflects what was *actually* marked
  // (markWikiStale self-skips entities without wiki-eligible backing), so callers
  // don't record stale-source credit for pages that will never regenerate.
  const staleEntityIds: number[] = [];
  if (store.sourceVisibility(sourceId).wikiEligible) {
    for (const id of changed) if (store.markWikiStale(id)) staleEntityIds.push(id);
  }

  return {
    affectedEntityIds: [...affected],
    staleEntityIds,
    newObservationIds,
    reinforcedObservationIds,
  };
}
