import type { KnowledgeStore } from "../knowledge/store.js";
import { isStale } from "../memory/temporal.js";

/**
 * Wiki quality scoring + lint (gist item 10): LLM-written pages accumulate noise
 * unless scored and repaired. This is deterministic — no LLM call — so it can
 * run over every page each consolidation cheaply.
 *
 * Issues are split by how safe they are to fix:
 *   - "auto"  → self-healing can repair without judgement (broken link, orphan).
 *   - "review"→ needs a human or a regeneration (unsupported/vague/stale claims).
 */
export type IssueSeverity = "auto" | "review";

export interface LintIssue {
  code:
    | "broken_link"
    | "orphan"
    | "missing_citations"
    | "ungrounded_claims"
    | "stale_claims"
    | "vague_claims"
    | "empty";
  severity: IssueSeverity;
  detail: string;
}

export interface PageLintResult {
  entityId: number;
  /** 0..1 health score; 1 is a clean, grounded, well-connected page. */
  quality: number;
  issues: LintIssue[];
}

const WIKI_LINK = /\[\[([^\]]+)\]\]/g;
const VAGUE = /\b(some|several|various|many|a few|a number of|certain|things|stuff|etc\.?)\b/gi;

/**
 * Lint one entity's page against its backing knowledge. Pure read — it computes
 * a score and issue list; persisting/repairing is the caller's job.
 */
export function lintPage(store: KnowledgeStore, entityId: number, body: string): PageLintResult {
  const issues: LintIssue[] = [];
  const observations = store.visibleObservations(entityId);
  const relationships = store.relationshipsFor(entityId);

  if (body.trim().length === 0) {
    return {
      entityId,
      quality: 0,
      issues: [{ code: "empty", severity: "review", detail: "page has no prose" }],
    };
  }

  // Broken links: [[X]] naming no known entity (auto-fixable via regeneration).
  const linked = new Set<string>();
  for (const m of body.matchAll(WIKI_LINK)) linked.add(m[1]!.trim());
  const broken = [...linked].filter((name) => name && !store.findEntityByName(name));
  if (broken.length > 0) {
    issues.push({
      code: "broken_link",
      severity: "auto",
      detail: `unknown links: ${broken.join(", ")}`,
    });
  }

  // Orphan: nothing connects this entity to the rest of the graph.
  if (relationships.length === 0) {
    issues.push({ code: "orphan", severity: "auto", detail: "no relationships to other entities" });
  }

  // Grounding / citations: how many claims are backed by a source.
  const grounded = observations.filter((o) => o.source_id !== null).length;
  const groundingRatio = observations.length === 0 ? 0 : grounded / observations.length;
  if (observations.length > 0 && grounded === 0) {
    issues.push({
      code: "missing_citations",
      severity: "review",
      detail: "no claim cites a source",
    });
  } else if (groundingRatio < 0.5) {
    issues.push({
      code: "ungrounded_claims",
      severity: "review",
      detail: `${observations.length - grounded} uncited claim(s)`,
    });
  }

  // Staleness: claims unconfirmed past their kind's horizon (a stale task and a
  // stale architecture decision are not the same age).
  const stale = observations.filter((o) => isStale(o)).length;
  const staleRatio = observations.length === 0 ? 0 : stale / observations.length;
  if (staleRatio > 0.5) {
    issues.push({
      code: "stale_claims",
      severity: "review",
      detail: `${stale} claim(s) unconfirmed past their freshness horizon`,
    });
  }

  // Vagueness: hedge words with no specifics, a sign of weak synthesis.
  const vagueHits = (body.match(VAGUE) ?? []).length;
  if (vagueHits >= 4) {
    issues.push({
      code: "vague_claims",
      severity: "review",
      detail: `${vagueHits} vague phrasings`,
    });
  }

  // Score: start at 1, subtract weighted penalties, clamp to [0,1].
  const meanConfidence =
    observations.length === 0
      ? 0
      : observations.reduce((sum, o) => sum + o.confidence, 0) / observations.length;
  let quality = 1;
  if (broken.length > 0) quality -= 0.25;
  if (relationships.length === 0) quality -= 0.15;
  quality -= (1 - groundingRatio) * 0.25;
  quality -= (1 - meanConfidence) * 0.15;
  quality -= staleRatio * 0.1;
  if (vagueHits >= 4) quality -= 0.1;
  quality = Math.max(0, Math.min(1, quality));

  return { entityId, quality, issues };
}
