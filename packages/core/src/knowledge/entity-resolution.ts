import type { KnowledgeStore } from "./store.js";

/**
 * Duplicate-entity detection (the human-gated half of stronger entity
 * resolution). The gist is explicit that LLMs corrupt graphs silently, so this
 * only *proposes* merges — a human applies them via store.mergeEntities. The
 * signals are deterministic:
 *
 *   nominal    — overlapping names/aliases (shared token, shared long prefix,
 *                or one name contained in the other). This is the *necessary*
 *                signal: identity is fundamentally about being the same named
 *                thing.
 *   structural — two same-type entities playing the identical role in the graph
 *                (e.g. both "founded → StudIA"). This only ever *corroborates* a
 *                nominal match; it is never sufficient on its own, because
 *                co-participation (two coworkers on one project, two vendors of
 *                one client) is structurally indistinguishable from identity and
 *                would otherwise propose merging clearly distinct entities.
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

/** Two tokens match on equality or a shared 4+ char prefix ("cgi"/"cgis"). */
function tokensMatch(x: string, y: string): boolean {
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x));
}

/**
 * How strongly two names point at the same thing, on a 0..1 scale. Exact or
 * containment matches score near 1; otherwise it is the Jaccard overlap of the
 * significant tokens. That grading matters: "CGI" vs "CGI Inc." overlap fully
 * (the lone token is shared) and score high, while "Data Migration" vs "Data
 * Pipeline" share only the common token "data" and score low — so a single
 * shared word in otherwise-different names is not mistaken for identity.
 */
function nominalSimilarity(a: string, b: string): number {
  const an = a.toLowerCase().trim();
  const bn = b.toLowerCase().trim();
  if (an === bn) return 1;
  if (an.length >= 5 && bn.includes(an)) return 0.9;
  if (bn.length >= 5 && an.includes(bn)) return 0.9;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  let shared = 0;
  for (const x of ta) {
    if (tb.some((y) => tokensMatch(x, y))) shared++;
  }
  const union = ta.length + tb.length - shared;
  return union > 0 ? shared / union : 0;
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
 * is only proposed when it shares the same type AND its names overlap. A strong
 * name match (near-identical) stands on its own; a weak one (a single shared
 * token) is proposed only when a shared graph role corroborates it. Structural
 * overlap never proposes a merge by itself — see the module header.
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
        const nominal = nominalSimilarity(a.name, b.name);

        // Name overlap is necessary. A strong name match carries the proposal on
        // its own; a weak one needs a shared graph role to corroborate it.
        if (nominal >= 0.6) {
          score += 0.4 + 0.4 * nominal;
          reasons.push("near-identical names");
        } else if (nominal > 0 && shared.length > 0) {
          score += 0.3 + 0.2 * nominal;
          reasons.push("overlapping names");
        } else {
          continue;
        }
        if (shared.length > 0) {
          score += Math.min(0.3, 0.15 * shared.length);
          reasons.push(`share ${shared.length} identical relationship${shared.length > 1 ? "s" : ""}`);
        }

        score = Math.min(1, score);
        if (score < 0.5) continue;
        const suggestedWinnerId = established(a.id) >= established(b.id) ? a.id : b.id;
        proposals.push({
          aId: a.id,
          bId: b.id,
          aName: a.name,
          bName: b.name,
          type: a.type,
          reasons,
          score,
          suggestedWinnerId,
        });
      }
    }
  }
  return proposals.sort((x, y) => y.score - x.score);
}
