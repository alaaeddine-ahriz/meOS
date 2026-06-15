import type { KnowledgeStore } from "../knowledge/store.js";

/**
 * Memory tiers (gist item 5): an abstraction ladder a claim climbs as evidence
 * accumulates.
 *
 *   working    — fresh, single-source capture
 *   episodic   — tied to a moment: an event/task, or something said in a session
 *   semantic   — a stable fact corroborated across independent sources
 *   procedural — a how-to / method / habit
 */
export type MemoryTier = "working" | "episodic" | "semantic" | "procedural";

const SEMANTIC_KINDS = new Set([
  "fact",
  "decision",
  "requirement",
  "preference",
  "risk",
  "open_question",
]);
const EPISODIC_KINDS = new Set(["event", "task"]);
const EPISODIC_SOURCE_TYPES = new Set(["conversation", "session"]);

/** How many independent sources make a corroborated claim "semantic". */
const SEMANTIC_SOURCE_THRESHOLD = 2;

/**
 * Where a claim belongs, by its kind, where it came from, and how widely it is
 * corroborated. Precedence: procedural > semantic > episodic > working.
 */
export function classifyMemoryTier(input: {
  kind: string;
  sourceType?: string;
  sourceCount: number;
}): MemoryTier {
  if (input.kind === "procedure") return "procedural";
  if (input.sourceCount >= SEMANTIC_SOURCE_THRESHOLD && SEMANTIC_KINDS.has(input.kind))
    return "semantic";
  if (
    EPISODIC_KINDS.has(input.kind) ||
    (input.sourceType && EPISODIC_SOURCE_TYPES.has(input.sourceType))
  ) {
    return "episodic";
  }
  return "working";
}

/**
 * Re-evaluate every active claim's tier — the operational step that lets a fact
 * graduate from working to semantic once a second source corroborates it.
 * Returns how many claims changed tier.
 */
export function reclassifyMemoryTiers(store: KnowledgeStore): number {
  let changed = 0;
  for (const row of store.observationTierInputs()) {
    const tier = classifyMemoryTier({
      kind: row.kind,
      sourceType: row.source_type ?? undefined,
      sourceCount: row.source_count,
    });
    if (tier !== row.memory_tier) {
      store.setMemoryTier(row.id, tier);
      changed++;
    }
  }
  return changed;
}
