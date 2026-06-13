export { defaultConfig, ensureDataDirs, LLM_PROVIDERS, loadConfig, overlayStoredLlmConfig } from "./config.js";
export type { LlmConfig, LlmProvider, MeosConfig } from "./config.js";
export { openDatabase } from "./db/database.js";
export type { MeosDatabase } from "./db/database.js";
export { createEmbedder, HashEmbedder, LocalEmbedder } from "./embedding/embedder.js";
export type { Embedder } from "./embedding/embedder.js";
export {
  cosineSimilarity,
  deserializeVector,
  reciprocalRankFusion,
  serializeVector,
  topK,
} from "./embedding/vectors.js";
export * from "./llm/index.js";
export { imageMediaType, parseDocument, SUPPORTED_EXTENSIONS } from "./ingest/parse.js";
export type { ParsedDocument } from "./ingest/parse.js";
export { chunkText } from "./ingest/chunk.js";
export { IngestionPipeline } from "./ingest/pipeline.js";
export type { IngestInput, IngestOutcome, PostMergeHook } from "./ingest/pipeline.js";
export { entityTypeSchema, extractionSchema, observationKindSchema, sensitivitySchema } from "./extract/schema.js";
export type { EntityType, ExtractedObservation, Extraction } from "./extract/schema.js";
export { containsPII, containsSecret, detectSensitivity, redactSecrets, REDACTION_PLACEHOLDER } from "./memory/privacy.js";
export { extractKnowledge } from "./extract/extractor.js";
export { readImage } from "./extract/image.js";
export { effectiveDate, KnowledgeStore, slugify } from "./knowledge/store.js";
export type {
  ChunkWithVector,
  EntityRow,
  InboxItemRow,
  ObservationRow,
  ObservationWithVector,
  RelationshipView,
  SourceChangeRow,
  SourceRef,
  WikiChange,
  WikiPageWithVector,
} from "./knowledge/store.js";
export {
  DEFAULT_SCHEMA_MD,
  ensureSchemaDoc,
  loadSchema,
  normalizeRelationshipLabel,
  OBSERVATION_KINDS,
  RELATIONSHIP_VOCABULARY,
  SCHEMA_FILE,
  SENSITIVITY_LEVELS,
  sensitivityRank,
  strongerSensitivity,
} from "./knowledge/schema-doc.js";
export type { ObservationKind, Sensitivity } from "./knowledge/schema-doc.js";
export { mergeExtraction } from "./knowledge/merge.js";
export type { MergeResult } from "./knowledge/merge.js";
export { findDuplicateEntities } from "./knowledge/entity-resolution.js";
export type { DuplicateProposal } from "./knowledge/entity-resolution.js";
export { WikiWriter } from "./wiki/writer.js";
export { lintPage } from "./wiki/wiki-lint.js";
export type { IssueSeverity, LintIssue, PageLintResult } from "./wiki/wiki-lint.js";
export { healWiki } from "./wiki/self-healing.js";
export type { HealingReport } from "./wiki/self-healing.js";
export { JobQueue, SerialQueue } from "./jobs/queue.js";
export { MeosEvents } from "./events.js";
export type { MeosEvent, MeosEventHandler, MeosEventMap } from "./events.js";
export { buildContextPack } from "./chat/retrieval.js";
export type { ContextPack, RetrievalOptions } from "./chat/retrieval.js";
export { classifyIntent } from "./chat/query-planner.js";
export type { QueryIntent } from "./chat/query-planner.js";
export { ChatService } from "./chat/chat.js";
export type { ChatResponseEvent } from "./chat/chat.js";
export {
  contradictionReport,
  decisionBrief,
  dependencyGraph,
  entityTimeline,
  meetingBrief,
} from "./outputs.js";
export type { OutputMode } from "./outputs.js";
export { detectContradictions } from "./memory/contradictions.js";
export type { ContradictionSummary } from "./memory/contradictions.js";
export { clampConfidence, initialConfidence, sourceQuality } from "./memory/confidence.js";
export { classifyMemoryTier, reclassifyMemoryTiers } from "./memory/memory-tiers.js";
export type { MemoryTier } from "./memory/memory-tiers.js";
export { expireStaleValidity } from "./memory/supersession.js";
export { runRetention } from "./memory/retention.js";
export type { RetentionReport } from "./memory/retention.js";
export { runConsolidation } from "./memory/consolidate.js";
export type { ConsolidationReport } from "./memory/consolidate.js";
export { applyResolution, proposeResolution } from "./memory/resolution.js";
export type { ResolutionAction, ResolutionProposal } from "./memory/resolution.js";
export { crystallizeSession } from "./memory/crystallize.js";
export type { SessionCrystal } from "./memory/crystallize.js";
