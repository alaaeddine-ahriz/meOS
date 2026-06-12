export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * On-device embeddings via transformers.js (ONNX). The model is downloaded
 * once to the local cache; no text ever leaves the machine for embedding.
 */
export class LocalEmbedder implements Embedder {
  readonly dimensions = 384;
  private pipelinePromise: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null;

  constructor(private readonly model: string) {}

  private loadPipeline() {
    if (!this.pipelinePromise) {
      this.pipelinePromise = import("@huggingface/transformers").then(async ({ pipeline }) => {
        const extractor = await pipeline("feature-extraction", this.model);
        return extractor as unknown as (texts: string[], opts: object) => Promise<{ tolist(): number[][] }>;
      });
    }
    return this.pipelinePromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extract = await this.loadPipeline();
    const output = await extract(texts, { pooling: "mean", normalize: true });
    return output.tolist().map((vector) => Float32Array.from(vector));
  }
}

/**
 * Deterministic token-hash embedder for tests: same text always maps to the
 * same vector, and overlapping vocabulary yields higher cosine similarity.
 */
export class HashEmbedder implements Embedder {
  readonly dimensions = 128;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vector = new Float32Array(this.dimensions);
      for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) {
        let hash = 5381;
        for (let i = 0; i < token.length; i++) {
          hash = ((hash << 5) + hash + token.charCodeAt(i)) | 0;
        }
        const slot = Math.abs(hash) % this.dimensions;
        vector[slot] = (vector[slot] ?? 0) + 1;
      }
      let norm = 0;
      for (const v of vector) norm += v * v;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / norm;
      return vector;
    });
  }
}

export function createEmbedder(provider: "local" | "hash", model: string): Embedder {
  return provider === "local" ? new LocalEmbedder(model) : new HashEmbedder();
}
