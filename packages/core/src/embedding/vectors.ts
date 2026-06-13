export function serializeVector(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function deserializeVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

/** Assumes both vectors are L2-normalised, so the dot product is the cosine. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * Reciprocal rank fusion: merge several ranked id-lists (e.g. a vector ranking
 * and a BM25 ranking) into one, scoring each id by Σ 1/(k + rank). Robust to
 * the very different score scales of cosine similarity and BM25 because it uses
 * only ordinal position. Returns ids best-first.
 */
export function reciprocalRankFusion(rankings: number[][], k = 60): number[] {
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export function topK<T>(
  items: T[],
  query: Float32Array,
  getVector: (item: T) => Float32Array | null,
  k: number,
): Array<{ item: T; score: number }> {
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const vector = getVector(item);
    if (!vector) continue;
    scored.push({ item, score: cosineSimilarity(query, vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
