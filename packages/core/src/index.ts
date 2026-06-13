export { defaultConfig, ensureDataDirs, LLM_PROVIDERS, loadConfig, overlayStoredLlmConfig } from "./config.js";
export type { LlmConfig, LlmProvider, MeosConfig } from "./config.js";
export { openDatabase } from "./db/database.js";
export type { MeosDatabase } from "./db/database.js";
export { createEmbedder, HashEmbedder, LocalEmbedder } from "./embedding/embedder.js";
export type { Embedder } from "./embedding/embedder.js";
export { cosineSimilarity, deserializeVector, serializeVector, topK } from "./embedding/vectors.js";
export * from "./llm/index.js";
export { imageMediaType, parseDocument, SUPPORTED_EXTENSIONS } from "./ingest/parse.js";
export type { ParsedDocument } from "./ingest/parse.js";
export { chunkText } from "./ingest/chunk.js";
export { IngestionPipeline } from "./ingest/pipeline.js";
export type { IngestInput, IngestOutcome, PostMergeHook } from "./ingest/pipeline.js";
export { entityTypeSchema, extractionSchema } from "./extract/schema.js";
export type { EntityType, Extraction } from "./extract/schema.js";
export { extractKnowledge } from "./extract/extractor.js";
export { readImage } from "./extract/image.js";
export { KnowledgeStore, slugify } from "./knowledge/store.js";
export type {
  ChunkWithVector,
  EntityRow,
  InboxItemRow,
  ObservationRow,
  RelationshipView,
  SourceChangeRow,
  SourceRef,
  WikiChange,
} from "./knowledge/store.js";
export { mergeExtraction } from "./knowledge/merge.js";
export type { MergeResult } from "./knowledge/merge.js";
export { WikiWriter } from "./wiki/writer.js";
export { JobQueue, SerialQueue } from "./jobs/queue.js";
export { buildContextPack } from "./chat/retrieval.js";
export type { ContextPack } from "./chat/retrieval.js";
export { ChatService } from "./chat/chat.js";
export type { ChatResponseEvent } from "./chat/chat.js";
export { detectContradictions } from "./memory/contradictions.js";
export type { ContradictionSummary } from "./memory/contradictions.js";
export { runConsolidation } from "./memory/consolidate.js";
export type { ConsolidationReport } from "./memory/consolidate.js";
