import type { KnowledgeStore } from "./store.js";

/**
 * Duplicate-entity detection (the human-gated half of stronger entity
 * resolution). The gist is explicit that LLMs corrupt graphs silently, so this
 * only *proposes* merges — a human applies them via store.mergeEntities. The
 * signals are deterministic:
 *
 *   structural — two same-type entities playing the identical role in the graph
 *                (e.g. both "founded → StudIA") are very likely the same thing.
 *   nominal    — overlapping names/aliases (shared token, shared long prefix,
 *                or one name contained in the other).
 */

export interface DuplicateProposal {
  aId: number;
  bId: number;
  aName: string;
  bName: string;
  type: string;
  reasons: string[];
  score: number;
  /** The id to keep (more-established entity), the other to merge into it. */
  suggestedWinnerId: number;
}

const STOPWORDS = new Set(["the", "and", "for", "of", "decision", "project", "team", "inc", "ltd"]);

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Names overlap: a shared token, a shared 4+ char prefix, or containment. */
function nominalOverlap(a: string, b: string): boolean {
  const an = a.toLowerCase().trim();
  const bn = b.toLowerCase().trim();
  if (an === bn) return true;
  if (an.length >= 5 && bn.includes(an)) return true;
  if (bn.length >= 5 && an.includes(bn)) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  for (const x of ta) {
    for (const y of tb) {
      if (x === y) return true;
      const short = x.length < y.length ? x : y;
      const long = x.length < y.length ? y : x;
      if (short.length >= 4 && long.startsWith(short)) return true;
    }
  }
  return false;
}

/** A set of "role keys" — the structural footprint of an entity in the graph. */
function roleKeys(store: KnowledgeStore, entityId: number): Set<string> {
  const keys = new Set<string>();
  for (const r of store.relationshipsFor(entityId)) {
    if (r.from_entity === entityId && r.to_entity !== entityId) keys.add(`out:${r.label}:${r.to_entity}`);
    else if (r.to_entity === entityId && r.from_entity !== entityId) keys.add(`in:${r.label}:${r.from_entity}`);
  }
  return keys;
}

/**
 * Propose likely-duplicate entity pairs, strongest first. Conservative: a pair
 * is only proposed when it shares the same type AND has either a structural
 * match (an identical graph role) or a nominal one (overlapping names) — and
 * structural matches that are *also* nominal score highest.
 */
export function findDuplicateEntities(store: KnowledgeStore): DuplicateProposal[] {
  const entities = store.listEntities();
  const byType = new Map<string, typeof entities>();
  for (const e of entities) byType.set(e.type, [...(byType.get(e.type) ?? []), e]);

  const roleCache = new Map<number, Set<string>>();
  const roles = (id: number) => {
    let r = roleCache.get(id);
    if (!r) roleCache.set(id, (r = roleKeys(store, id)));
    return r;
  };
  const obsCount = new Map<number, number>();
  const established = (id: number) => {
    let n = obsCount.get(id);
    if (n === undefined) obsCount.set(id, (n = store.activeObservations(id).length));
    return n;
  };

  const proposals: DuplicateProposal[] = [];
  for (const group of byType.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const reasons: string[] = [];
        let score = 0;

        const shared = [...roles(a.id)].filter((k) => roles(b.id).has(k));
        if (shared.length > 0) {
          score += 0.6 + Math.min(0.2, 0.1 * (shared.length - 1));
          reasons.push(`share ${shared.length} identical relationship${shared.length > 1 ? "s" : ""}`);
        }
        if (nominalOverlap(a.name, b.name)) {
          score += 0.4;
          reasons.push("overlapping names");
        }

        if (reasons.length === 0 || score < 0.4) continue;
        const suggestedWinnerId = established(a.id) >= established(b.id) ? a.id : b.id;
        proposals.push({
          aId: a.id,
          bId: b.id,
          aName: a.name,
          bName: b.name,
          type: a.type,
          reasons,
          score: Math.min(1, score),
          suggestedWinnerId,
        });
      }
    }
  }
  return proposals.sort((x, y) => y.score - x.score);
}
