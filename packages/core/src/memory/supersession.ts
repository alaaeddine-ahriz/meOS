import type { KnowledgeStore } from "../knowledge/store.js";

/**
 * Time-based supersession (gist item 4): a claim with a stated validUntil that
 * has passed is no longer current. This runs deterministically, independent of
 * the LLM contradiction judge — "valid until 2024" simply expires once 2024 is
 * over. Expired claims are retired (status superseded), never silently kept, and
 * their pages flagged for a rewrite. Returns how many claims expired.
 */
export function expireStaleValidity(store: KnowledgeStore, asOf = new Date()): number {
  const today = asOf.toISOString().slice(0, 10);
  return store.expireObservationsByValidity(today);
}
