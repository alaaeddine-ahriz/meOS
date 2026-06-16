/**
 * Pure, deterministic metric helpers shared by the benchmark runners.
 * No I/O, no randomness — same inputs always yield the same numbers.
 */

/** Round to a fixed number of decimals so JSON/CSV output is stable. */
export function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Mean of a list of numbers (0 for an empty list). */
export function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Hit@k: 1 if any relevant id appears in the top-k of `ranked`, else 0.
 * `ranked` is an ordered list of ids; `relevant` is a set/array of ground-truth ids.
 */
export function hitAtK(ranked, relevant, k) {
  const rel = new Set(relevant);
  return ranked.slice(0, k).some((id) => rel.has(id)) ? 1 : 0;
}

/**
 * Reciprocal rank of the first relevant id in `ranked` (1/rank), or 0 if none
 * appear. Averaged across queries this is the Mean Reciprocal Rank (MRR).
 */
export function reciprocalRank(ranked, relevant) {
  const rel = new Set(relevant);
  for (let i = 0; i < ranked.length; i++) {
    if (rel.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Citation accuracy (precision of surfaced citations): of the sources the
 * retrieval cited, the fraction that were actually relevant for the query.
 * 1 when nothing was cited and nothing was expected; 0 when citations exist but
 * none are relevant.
 */
export function citationPrecision(cited, relevant) {
  const rel = new Set(relevant);
  if (cited.length === 0) return relevant.length === 0 ? 1 : 0;
  const correct = cited.filter((id) => rel.has(id)).length;
  return correct / cited.length;
}

/**
 * False-positive rate among cited sources: the fraction of cited sources that
 * were NOT relevant. Complement of citation precision when citations exist.
 */
export function falsePositiveRate(cited, relevant) {
  if (cited.length === 0) return 0;
  const rel = new Set(relevant);
  const wrong = cited.filter((id) => !rel.has(id)).length;
  return wrong / cited.length;
}
