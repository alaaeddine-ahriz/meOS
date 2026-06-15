/**
 * Confidence policy — the single place the lifecycle's magic numbers live, so
 * "how sure are we" is governed by one set of rules (gist item 4) instead of
 * being scattered through the store.
 *
 *   new claim     → starts from the extractor's confidence × source quality
 *   repeated      → rises by REINFORCE_STEP per *distinct* source (capped)
 *   unconfirmed   → decays toward FLOOR after DECAY_AFTER_DAYS
 *   corroborated  → promoted to an established "fact" past PROMOTE_THRESHOLD
 */

export const CONFIDENCE_FLOOR = 0.05;
export const CONFIDENCE_CAP = 0.95;
export const REINFORCE_STEP = 0.15;
export const DECAY_AFTER_DAYS = 30;
export const DECAY_STEP = 0.01;
export const PROMOTE_THRESHOLD = 0.75;

/** Relative trust in a source type — a watched document outranks a chat aside. */
const SOURCE_QUALITY: Record<string, number> = {
  file: 1,
  watch: 1,
  text: 1,
  upload: 1,
  image: 0.9,
  session: 0.9,
  conversation: 0.85,
};

export function sourceQuality(sourceType: string | undefined): number {
  if (!sourceType) return 1;
  return SOURCE_QUALITY[sourceType] ?? 1;
}

export function clampConfidence(value: number): number {
  return Math.min(CONFIDENCE_CAP, Math.max(CONFIDENCE_FLOOR, value));
}

/**
 * Confidence a freshly extracted claim should start at: the extractor's own
 * confidence, discounted by how much we trust the source it came from.
 */
export function initialConfidence(
  extractionConfidence: number,
  sourceType: string | undefined,
): number {
  const base = Number.isFinite(extractionConfidence) ? extractionConfidence : 0.5;
  return clampConfidence(base * sourceQuality(sourceType));
}
