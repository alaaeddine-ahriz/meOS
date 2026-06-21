import { cosineSimilarity } from "../embedding/vectors.js";
import type { EntityType } from "../extract/schema.js";
import type { EntityRow, KnowledgeStore } from "./store.js";
import { slugify } from "./store.js";

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

const STOPWORDS = new Set(["the", "and", "for", "of", "decision", "project", "team"]);

/**
 * Organisation-form suffixes ("Acme Inc." ≡ "Acme GmbH" ≡ "Acme"). Stripped
 * before comparison so a company written with and without its legal form folds
 * into one entity instead of fragmenting.
 */
const ORG_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "ltd",
  "limited",
  "llc",
  "llp",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "sarl",
  "bv",
  "nv",
  "co",
  "corp",
  "corporation",
  "company",
  "group",
  "holdings",
  "pty",
  "srl",
  "spa",
  "oy",
  "ab",
]);

/**
 * Accent/diacritic-insensitive, lower-cased form. "Aurélie" and "Aurelie",
 * "São Paulo" and "Sao Paulo" normalise to the same string so the same person,
 * place, or org under an accented and an ASCII spelling fold into one entity.
 */
export function foldName(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();
}

function tokens(name: string): string[] {
  return foldName(name)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !ORG_SUFFIXES.has(t));
}

/** Two tokens match on equality or a shared 4+ char prefix ("cgi"/"cgis"). */
function tokensMatch(x: string, y: string): boolean {
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x));
}

/**
 * The initialism of a multi-word name ("Massachusetts Institute of Technology"
 * → "mit"). Built from the leading letter of each significant token (3+ chars,
 * non-stopword), so a name and its abbreviation can be recognised as the same
 * thing. Returns "" when there is only one significant token (nothing to
 * abbreviate).
 */
function initialism(name: string): string {
  const sig = foldName(name)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 1 && !STOPWORDS.has(t) && !ORG_SUFFIXES.has(t));
  if (sig.length < 2) return "";
  return sig.map((t) => t[0]).join("");
}

/** The acronym-form of a name with no spaces, lower-cased ("M.I.T." → "mit"). */
function acronymForm(name: string): string {
  return foldName(name).replace(/[^a-z0-9]+/g, "");
}

/**
 * True when one name is an abbreviation/initialism of the other:
 * "MIT" ↔ "Massachusetts Institute of Technology", "JPL" ↔ "Jet Propulsion Lab".
 * Only fires for a genuinely short acronym (2..6 chars) against a longer
 * multi-word name, so it never collapses two short codes together.
 */
function isAbbreviationOf(a: string, b: string): boolean {
  const aa = acronymForm(a);
  const bb = acronymForm(b);
  const tryOne = (abbr: string, full: string): boolean => {
    if (abbr.length < 2 || abbr.length > 6) return false;
    return initialism(full) === abbr;
  };
  return tryOne(aa, b) || tryOne(bb, a);
}

/**
 * How strongly two names point at the same thing, on a 0..1 scale. Exact
 * (accent-insensitive) or containment matches score near 1; a recognised
 * abbreviation scores high; otherwise it is the Jaccard overlap of the
 * significant tokens. That grading matters: "CGI" vs "CGI Inc." overlap fully
 * (the lone token is shared, the legal suffix stripped) and score high, while
 * "Data Migration" vs "Data Pipeline" share only the common token "data" and
 * score low — so a single shared word in otherwise-different names is not
 * mistaken for identity.
 */
export function nominalSimilarity(a: string, b: string): number {
  const an = foldName(a);
  const bn = foldName(b);
  if (an === bn) return 1;
  // After stripping org-form suffixes the bare names may be identical.
  if (tokens(a).join(" ") === tokens(b).join(" ") && tokens(a).length > 0) return 0.95;
  if (an.length >= 5 && bn.includes(an)) return 0.9;
  if (bn.length >= 5 && an.includes(bn)) return 0.9;
  if (isAbbreviationOf(a, b)) return 0.85;
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
    if (r.from_entity === entityId && r.to_entity !== entityId)
      keys.add(`out:${r.label}:${r.to_entity}`);
    else if (r.to_entity === entityId && r.from_entity !== entityId)
      keys.add(`in:${r.label}:${r.from_entity}`);
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
  for (const e of entities) {
    const group = byType.get(e.type);
    if (group) group.push(e);
    else byType.set(e.type, [e]);
  }

  // Pairs the user has explicitly rejected merging — never re-propose them.
  const dismissed = store.dismissedDuplicateKeys();

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
  const contactCache = new Map<number, Set<string>>();
  const contacts = (e: { id: number; name: string }) => {
    let c = contactCache.get(e.id);
    if (!c) contactCache.set(e.id, (c = contactKeys(e.name, store.aliasesFor(e.id))));
    return c;
  };

  const proposals: DuplicateProposal[] = [];
  for (const group of byType.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
        if (dismissed.has(key)) continue;
        const reasons: string[] = [];
        let score = 0;

        const shared = [...roles(a.id)].filter((k) => roles(b.id).has(k));
        const nominal = nominalSimilarity(a.name, b.name);
        const sharedContact = [...contacts(a)].filter((k) => contacts(b).has(k));
        const sharedEmail = sharedContact.some((k) => k.startsWith("email:"));

        // Name overlap is the usual necessary signal. A strong name match carries
        // the proposal on its own; a weak one needs a shared graph role. A shared
        // email address is an identity signal strong enough to stand alone.
        if (nominal >= 0.6) {
          score += 0.4 + 0.4 * nominal;
          reasons.push("near-identical names");
        } else if (nominal > 0 && (shared.length > 0 || sharedContact.length > 0)) {
          score += 0.3 + 0.2 * nominal;
          reasons.push("overlapping names");
        } else if (sharedEmail) {
          score += 0.7;
          reasons.push("shared email");
        } else {
          continue;
        }
        if (sharedContact.length > 0 && !reasons.includes("shared email")) {
          score += sharedEmail ? 0.25 : 0.15;
          reasons.push(sharedEmail ? "shared email" : "shared domain");
        }
        if (shared.length > 0) {
          score += Math.min(0.3, 0.15 * shared.length);
          reasons.push(
            `share ${shared.length} identical relationship${shared.length > 1 ? "s" : ""}`,
          );
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

/**
 * Pre-creation candidate generation. Before the merge step creates a brand-new
 * entity for an extracted name, it asks "is this actually one we already hold,
 * just written differently?". This widens the conservative exact-name/slug
 * lookup with fuzzy, abbreviation-, accent-, and org-suffix-aware matching plus
 * an optional embedding-similarity signal — but it never silently merges an
 * uncertain match. Instead it returns a confidence-scored decision:
 *
 *   "merge"   — high confidence; resolve the extracted name to the existing
 *               entity (and record any new surface form as an alias).
 *   "review"  — plausible but not certain; create the new entity as before, but
 *               surface the pair through the human-gated duplicates review so it
 *               can be merged or dismissed deliberately.
 *   null      — no credible existing match; create a fresh entity.
 *
 * Email/domain/project hints ride in via `aliases` (extractors emit a person's
 * email and an org's domain as aliases); a shared email or domain corroborates
 * a nominal match the same way a shared graph role does.
 */
export interface ResolutionDecision {
  entity: EntityRow;
  /** "merge" routes to the existing entity now; "review" queues the pair. */
  action: "merge" | "review";
  confidence: number;
  reasons: string[];
}

/** Confidence at or above which a candidate is folded in without human review. */
export const MERGE_CONFIDENCE = 0.86;
/** Confidence at or above which an ambiguous candidate is queued for review. */
export const REVIEW_CONFIDENCE = 0.55;

/** Extract email addresses and bare domains from a name and its aliases. */
function contactKeys(name: string, aliases: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const raw of [name, ...aliases]) {
    const text = raw.toLowerCase().trim();
    const email = text.match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/);
    if (email) {
      keys.add(`email:${email[0]}`);
      keys.add(`domain:${email[1]}`);
    } else if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(text)) {
      keys.add(`domain:${text}`);
    }
  }
  return keys;
}

/**
 * Score how strongly an extracted candidate matches an existing entity, fusing
 * the nominal signal (over the entity's name *and* its aliases — so a known
 * alias or codename matches) with shared contact keys (email/domain) and, when
 * a representative vector is supplied, embedding similarity.
 */
function scoreCandidate(
  store: KnowledgeStore,
  entity: EntityRow,
  candidateName: string,
  candidateContacts: Set<string>,
  candidateVector: Float32Array | undefined,
): { confidence: number; reasons: string[] } {
  const reasons: string[] = [];
  const surfaces = [entity.name, ...store.aliasesFor(entity.id)];
  let nominal = 0;
  for (const s of surfaces) nominal = Math.max(nominal, nominalSimilarity(candidateName, s));

  let confidence = 0;
  if (nominal >= 0.95) {
    confidence = nominal;
    reasons.push("near-identical name");
  } else if (nominal >= 0.6) {
    // A solidly-overlapping name (org suffix, abbreviation, near-match) is enough
    // to stand on its own as a review candidate.
    confidence = 0.45 + 0.4 * nominal;
    reasons.push("similar name");
  } else if (nominal > 0) {
    // A single shared token ("Data Migration" vs "Data Pipeline") is far too weak
    // to propose a merge on names alone — it only counts once a contact or
    // embedding signal corroborates it below, mirroring findDuplicateEntities.
    confidence = 0.2 + 0.2 * nominal;
    reasons.push("weak name overlap");
  }

  // Shared email/domain is a strong identity signal and can lift an otherwise
  // weak nominal match over the review line.
  const entityContacts = contactKeys(entity.name, store.aliasesFor(entity.id));
  const sharedContact = [...candidateContacts].filter((k) => entityContacts.has(k));
  const sharedEmail = sharedContact.some((k) => k.startsWith("email:"));
  if (sharedContact.length > 0) {
    confidence += sharedEmail ? 0.4 : 0.25;
    reasons.push(sharedEmail ? "shared email" : "shared domain");
  }

  // Embedding similarity corroborates but never proposes on its own — it only
  // adds weight once a nominal or contact signal already exists.
  if (candidateVector && (nominal > 0 || sharedContact.length > 0)) {
    const vectors = store.activeObservationVectors(entity.id);
    let best = 0;
    for (const v of vectors) best = Math.max(best, cosineSimilarity(candidateVector, v.vector));
    if (best >= 0.6) {
      confidence += Math.min(0.15, 0.25 * (best - 0.6));
      reasons.push("similar context");
    }
  }

  return { confidence: Math.min(1, confidence), reasons };
}

/**
 * Find the best existing entity for an extracted candidate and decide whether
 * to merge into it, queue it for review, or treat it as new. Only entities of
 * the same type are considered. Pairs the user has already dismissed are never
 * proposed for review (they fall back to creating a fresh entity).
 */
export function resolveCandidate(
  store: KnowledgeStore,
  candidate: { name: string; type: EntityType; aliases?: readonly string[] },
  opts: { vector?: Float32Array; dismissed?: Set<string> } = {},
): ResolutionDecision | null {
  // Exact name/alias and slug remain the fast, certain path — but only within
  // the same entity type (a project "Orion" is not the organisation "Orion").
  const exact =
    store.findEntityByName(candidate.name) ?? store.getEntityBySlug(slugify(candidate.name));
  if (exact && exact.type === candidate.type) {
    return { entity: exact, action: "merge", confidence: 1, reasons: ["exact name"] };
  }

  const contacts = contactKeys(candidate.name, candidate.aliases ?? []);
  let best: ResolutionDecision | null = null;
  for (const entity of store.listEntities()) {
    if (entity.type !== candidate.type) continue;
    const { confidence, reasons } = scoreCandidate(
      store,
      entity,
      candidate.name,
      contacts,
      opts.vector,
    );
    if (confidence < REVIEW_CONFIDENCE) continue;
    const action: "merge" | "review" = confidence >= MERGE_CONFIDENCE ? "merge" : "review";
    if (!best || confidence > best.confidence) {
      best = { entity, action, confidence, reasons };
    }
  }
  return best;
}
