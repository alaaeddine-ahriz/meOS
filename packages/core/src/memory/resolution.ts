import { sourceQuality } from "./confidence.js";
import { effectiveDate, type KnowledgeStore } from "../knowledge/store.js";

/**
 * Contradiction resolution (gist item 11): detection is step one, resolving is
 * step two. This proposes — never imposes — a resolution by comparing the two
 * claims on recency, source authority, confidence, and corroboration. A human
 * accepts, overrides, keeps both, or marks them context-specific.
 */

export type ResolutionAction = "supersede_a" | "supersede_b" | "keep_both" | "context_specific";

export interface ResolutionProposal {
  contradictionId: number;
  /** The suggested action; the user can choose any of the others. */
  suggested: ResolutionAction;
  /** Plain-language justification ("the newer claim, from a more authoritative source"). */
  rationale: string;
  /** 0..1 — how decisively the signals favoured the suggestion. */
  margin: number;
}

interface Side {
  id: number;
  recency: number; // ms epoch of validFrom or created_at
  confidence: number;
  authority: number; // source quality of the backing source type
  sourceCount: number;
}

function scoreSide(side: Side): number {
  // Recency normalised against "now"; the rest are already 0..1-ish.
  const ageDays = Math.max(0, (Date.now() - side.recency) / 86_400_000);
  const recencyScore = 1 / (1 + ageDays / 365); // ~1 for today, decays over a year
  const corroboration = Math.min(1, side.sourceCount / 3);
  return 0.4 * recencyScore + 0.3 * side.confidence + 0.2 * side.authority + 0.1 * corroboration;
}

/**
 * Propose how to resolve an open contradiction. Returns undefined if the
 * contradiction is unknown or already resolved.
 */
export function proposeResolution(
  store: KnowledgeStore,
  contradictionId: number,
): ResolutionProposal | undefined {
  const contradiction = store.getContradiction(contradictionId);
  if (!contradiction || contradiction.resolved) return undefined;

  const load = (id: number): Side | undefined => {
    const o = store.getObservation(id);
    if (!o) return undefined;
    return {
      id,
      recency: Date.parse(effectiveDate(o)) || Date.now(),
      confidence: o.confidence,
      authority: sourceQuality(o.source_id ? store.getSourceType(o.source_id) : undefined),
      sourceCount: store.observationSourceCount(id),
    };
  };

  const a = load(contradiction.observation_a);
  const b = load(contradiction.observation_b);
  if (!a || !b) return undefined;

  const scoreA = scoreSide(a);
  const scoreB = scoreSide(b);
  const margin = Math.abs(scoreA - scoreB);

  // Too close to call confidently: don't retire either side automatically.
  if (margin < 0.08) {
    return {
      contradictionId,
      suggested: "keep_both",
      rationale:
        "The two claims are similarly recent and well-supported — likely both valid in different contexts, or a human should decide.",
      margin,
    };
  }

  const aWins = scoreA > scoreB;
  const winner = aWins ? a : b;
  const loser = aWins ? b : a;
  const reasons = [
    winner.recency > loser.recency ? "more recent" : null,
    winner.authority > loser.authority ? "from a more authoritative source" : null,
    winner.confidence > loser.confidence ? "higher confidence" : null,
    winner.sourceCount > loser.sourceCount ? "corroborated by more sources" : null,
  ].filter(Boolean);

  return {
    contradictionId,
    suggested: aWins ? "supersede_b" : "supersede_a",
    rationale: `Supersede the other claim: this one is ${reasons.join(", ") || "better supported"}.`,
    margin,
  };
}

/**
 * Apply a chosen resolution. "supersede_*" retires the losing side in favour of
 * the winner; "keep_both"/"context_specific" simply close the contradiction
 * (both claims stay active). Returns false for an unknown/closed contradiction.
 */
export function applyResolution(
  store: KnowledgeStore,
  contradictionId: number,
  action: ResolutionAction,
): boolean {
  const contradiction = store.getContradiction(contradictionId);
  if (!contradiction || contradiction.resolved) return false;
  const { observation_a, observation_b } = contradiction;
  if (action === "supersede_a") {
    store.resolveContradiction(contradictionId, {
      loserId: observation_a,
      winnerId: observation_b,
    });
  } else if (action === "supersede_b") {
    store.resolveContradiction(contradictionId, {
      loserId: observation_b,
      winnerId: observation_a,
    });
  } else {
    store.resolveContradiction(contradictionId);
  }
  store.logAudit("resolve_contradiction", `contradiction ${contradictionId} resolved: ${action}`);
  return true;
}
