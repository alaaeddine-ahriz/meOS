import { Worker } from "node:worker_threads";

export interface EmbedOptions {
  /** User-facing requests (chat, search) jump ahead of bulk ingestion work. */
  interactive?: boolean;
}

export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[], opts?: EmbedOptions): Promise<Float32Array[]>;
}

/**
 * Runs inside a worker thread: onnxruntime-node executes the whole model
 * graph synchronously in the calling thread, so embedding on the main thread
 * would freeze the API for the duration of every batch.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
let extractorPromise = null;
function load() {
  if (!extractorPromise) {
    extractorPromise = import(workerData.transformersUrl).then(({ pipeline, env }) => {
      // The default cache lives under node_modules, which is read-only inside a
      // packaged desktop app; MEOS_MODEL_CACHE points it at a writable dir.
      if (workerData.cacheDir) env.cacheDir = workerData.cacheDir;
      return pipeline("feature-extraction", workerData.model);
    });
  }
  return extractorPromise;
}
// Two queues so a chat query never waits behind a pile of ingestion batches.
const urgent = [];
const bulk = [];
let running = false;
async function pump() {
  if (running) return;
  running = true;
  while (urgent.length > 0 || bulk.length > 0) {
    const job = urgent.shift() ?? bulk.shift();
    try {
      const extract = await load();
      const output = await extract(job.texts, { pooling: "mean", normalize: true });
      parentPort.postMessage({ id: job.id, vectors: output.tolist() });
    } catch (error) {
      parentPort.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  running = false;
}
parentPort.on("message", (job) => {
  (job.interactive ? urgent : bulk).push(job);
  void pump();
});
`;

/**
 * Bulk embeds are sent to the worker in small slices so an interactive
 * request only ever waits for the slice in flight, not a whole document.
 */
const BULK_BATCH_SIZE = 8;

/**
 * On-device embeddings via transformers.js (ONNX). The model is downloaded
 * once to the local cache; no text ever leaves the machine for embedding.
 * Inference happens in a dedicated worker thread to keep the server loop free.
 */
export class LocalEmbedder implements Embedder {
  readonly dimensions = 384;
  private worker: Worker | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (vectors: Float32Array[]) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly model: string) {}

  private ensureWorker(): Worker {
    if (!this.worker) {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          model: this.model,
          transformersUrl: import.meta.resolve("@huggingface/transformers"),
          cacheDir: process.env.MEOS_MODEL_CACHE,
        },
      });
      worker.unref();
      worker.on("message", ({ id, vectors, error }: { id: number; vectors?: number[][]; error?: string }) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (vectors) entry.resolve(vectors.map((vector) => Float32Array.from(vector)));
        else entry.reject(new Error(error ?? "embedding worker returned no output"));
      });
      worker.on("error", (error) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        for (const { reject } of this.pending.values()) reject(failure);
        this.pending.clear();
        this.worker = null;
      });
      this.worker = worker;
    }
    return this.worker;
  }

  private request(texts: string[], interactive: boolean): Promise<Float32Array[]> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, texts, interactive });
    });
  }

  async embed(texts: string[], opts?: EmbedOptions): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const interactive = opts?.interactive ?? false;
    const batchSize = interactive ? texts.length : BULK_BATCH_SIZE;
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) batches.push(texts.slice(i, i + batchSize));
    const results = await Promise.all(batches.map((batch) => this.request(batch, interactive)));
    return results.flat();
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
