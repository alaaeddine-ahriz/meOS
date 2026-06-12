export { defaultConfig, ensureDataDirs, loadConfig } from "./config.js";
export type { MeosConfig } from "./config.js";
export { openDatabase } from "./db/database.js";
export type { MeosDatabase } from "./db/database.js";
export { createEmbedder, HashEmbedder, LocalEmbedder } from "./embedding/embedder.js";
export type { Embedder } from "./embedding/embedder.js";
export { cosineSimilarity, deserializeVector, serializeVector, topK } from "./embedding/vectors.js";
export * from "./llm/index.js";
export { parseDocument } from "./ingest/parse.js";
export type { ParsedDocument } from "./ingest/parse.js";
export { chunkText } from "./ingest/chunk.js";
export { IngestionPipeline } from "./ingest/pipeline.js";
export type { IngestInput, IngestOutcome, PostMergeHook } from "./ingest/pipeline.js";
export { entityTypeSchema, extractionSchema } from "./extract/schema.js";
export type { EntityType, Extraction } from "./extract/schema.js";
export { extractKnowledge } from "./extract/extractor.js";
export { KnowledgeStore, slugify } from "./knowledge/store.js";
export type {
  ChunkWithVector,
  EntityRow,
  InboxItemRow,
  ObservationRow,
  RelationshipView,
} from "./knowledge/store.js";
export { mergeExtraction } from "./knowledge/merge.js";
export type { MergeResult } from "./knowledge/merge.js";
export { WikiWriter } from "./wiki/writer.js";
export { SerialQueue } from "./jobs/queue.js";
export { buildContextPack } from "./chat/retrieval.js";
export type { ContextPack } from "./chat/retrieval.js";
export { ChatService } from "./chat/chat.js";
