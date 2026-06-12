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
