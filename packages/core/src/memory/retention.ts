import type { KnowledgeStore } from "../knowledge/store.js";
import { DECAY_AFTER_DAYS, DECAY_STEP, PROMOTE_THRESHOLD } from "./confidence.js";
import { reclassifyMemoryTiers } from "./memory-tiers.js";
import { expireStaleValidity } from "./supersession.js";

export interface RetentionReport {
  /** Claims whose confidence decayed for going long unconfirmed. */
  decayed: number;
  /** Observations promoted to established facts past the threshold. */
  promoted: number;
  /** Claims retired because their stated validity window has passed. */
  expired: number;
  /** Claims that moved tier (e.g. working → semantic) this pass. */
  retiered: number;
}

/**
 * The retention pass (gist item 4): age unconfirmed knowledge, expire claims
 * past their validity, promote corroborated observations to facts, and re-rank
 * the memory tiers. Pure orchestration over the store's lifecycle primitives so
 * the policy lives in one place.
 */
export function runRetention(store: KnowledgeStore): RetentionReport {
  const expired = expireStaleValidity(store);
  const decayed = store.decayStaleConfidence(DECAY_AFTER_DAYS, DECAY_STEP);
  const promoted = store.promoteFacts(PROMOTE_THRESHOLD);
  const retiered = reclassifyMemoryTiers(store);
  return { decayed, promoted, expired, retiered };
}
