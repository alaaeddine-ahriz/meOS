import type { KnowledgeStore } from "../knowledge/store.js";
import { lintPage, type PageLintResult } from "./wiki-lint.js";

export interface HealingReport {
  /** Pages whose auto-fixable issues (broken links, orphan prose) flagged a rewrite. */
  flaggedForRepair: number;
  /** Pages scoring below the review threshold, for the digest to surface. */
  lowQuality: Array<{ entity_id: number; entity_name: string; quality: number }>;
  /** Mean page quality across the wiki, or null when there are no pages. */
  meanQuality: number | null;
}

/**
 * Lint every wiki page, persist its score, and queue self-healing (gist item 10).
 * Pages with an "auto" issue (a broken [[link]] or orphan prose) are marked stale
 * so the next regeneration repairs them; "review" issues are left for the digest
 * to surface. Runs before regeneration so the same consolidation pass fixes what
 * it finds.
 */
export function healWiki(store: KnowledgeStore, reviewThreshold = 0.6): HealingReport {
  let flaggedForRepair = 0;
  const scores: number[] = [];

  for (const page of store.wikiPageBodies()) {
    const result: PageLintResult = lintPage(store, page.entity_id, page.body);
    store.setWikiQuality(page.entity_id, result.quality);
    scores.push(result.quality);
    if (result.issues.some((issue) => issue.severity === "auto")) {
      store.markWikiStale(page.entity_id);
      flaggedForRepair++;
    }
  }

  return {
    flaggedForRepair,
    lowQuality: store.lowQualityPages(reviewThreshold),
    meanQuality: scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length,
  };
}
