export {
  defaultConfig,
  ensureDataDirs,
  LLM_PROVIDERS,
  loadConfig,
  overlayStoredLlmConfig,
} from "./config.js";
export type { LlmConfig, LlmProvider, MeosConfig } from "./config.js";
export { createLogger, logger } from "./logger.js";
export { openDatabase, resetDatabase } from "./db/database.js";
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
export {
  blocksFromDocxHtml,
  blocksFromText,
  imageMediaType,
  parseCsv,
  parseDocument,
  parseJson,
  SUPPORTED_EXTENSIONS,
} from "./ingest/parse.js";
export type { Block, BlockType, ParsedDocument } from "./ingest/parse.js";
export { chunkBlocks, chunkText, estimateTokens } from "./ingest/chunk.js";
export type { ChunkOptions, ChunkWithMetadata } from "./ingest/chunk.js";
export { IngestionPipeline } from "./ingest/pipeline.js";
export type { IngestInput, IngestOutcome, PostMergeHook } from "./ingest/pipeline.js";
export {
  composeMeetingMarkdown,
  MEETING_EXTRACTION_LENS,
  meetingSourcePath,
  processMeetingNote,
} from "./ingest/meeting.js";
export type { MeetingNoteInput, MeetingProcessResult } from "./ingest/meeting.js";
export {
  detectMeeting,
  meetingHeuristicScore,
  MEETING_DETECTION_THRESHOLD,
  MEETING_HEURISTIC_FLOOR,
} from "./ingest/meeting-detect.js";
export type { MeetingDetectionResult, MeetingDetectionMethod } from "./ingest/meeting-detect.js";
export { suggestMeetingLinks } from "./knowledge/meeting-links.js";
export type { MeetingLinkSuggestion } from "./knowledge/meeting-links.js";
export {
  entityTypeSchema,
  extractionSchema,
  observationKindSchema,
  relevanceSchema,
  sensitivitySchema,
} from "./extract/schema.js";
export type { EntityType, ExtractedObservation, Extraction, Relevance } from "./extract/schema.js";
export {
  containsPII,
  containsSecret,
  detectSensitivity,
  redactSecrets,
  REDACTION_PLACEHOLDER,
} from "./memory/privacy.js";
export { extractKnowledge } from "./extract/extractor.js";
export { reduceExtractions } from "./extract/reduce.js";
export {
  extractKnowledgeMapReduce,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SCHEMA_VERSION,
  SINGLE_PASS_TOKEN_LIMIT,
  schemaDocVersion,
  profileVersion,
} from "./extract/map-reduce.js";
export type { ExtractionRunResult, MapReduceOptions } from "./extract/map-reduce.js";
export { readImage } from "./extract/image.js";
export { effectiveDate, IngestPriority, KnowledgeStore, slugify } from "./knowledge/store.js";
export type {
  ChunkInput,
  ChunkMetadataRow,
  ChunkWithVector,
  ConnectorAccountRow,
  ConnectorSyncStateRow,
  EntityRow,
  ExtractionCacheKey,
  ExtractionCacheRow,
  ExtractionStrategy,
  InboxItemRow,
  IngestCostMetric,
  IngestJobRow,
  MeetingLinkMethod,
  MeetingLinkStatus,
  MeetingLinkSuggestionRow,
  MeetingNoteRow,
  IngestJobState,
  IngestQueueDepth,
  IngestQueueKind,
  IngestQueueMetrics,
  IngestRecoveryMetrics,
  IngestRunRow,
  IngestStageMetric,
  ObservationRow,
  ObservationWithVector,
  RelationshipView,
  SourceChangeRow,
  SourceRef,
  SourceRevisionRow,
  SourceRevisionStatus,
  StaleBackedObservationRow,
  Subgraph,
  SubgraphEdge,
  SubgraphNode,
  WikiAuthor,
  WikiChange,
  WikiMaintenanceMode,
  WikiPageMeta,
  WikiPageWithVector,
  WikiRunEventKind,
  WikiRunEventRow,
  WikiRunRow,
  WorkerHealthRecord,
  WorkerHealthSnapshot,
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
export {
  defaultPreferences,
  enabledEntityTypes,
  enabledObservationKinds,
  ENTITY_TYPES,
  KNOWLEDGE_PRESETS,
  preferencesForPreset,
  preferencesVersion,
  preferencesAreUnrestricted,
  resolvePreferences,
  withPreferences,
} from "./knowledge/preferences.js";
export type {
  EntityTypeToggles,
  KnowledgePreferences,
  KnowledgePreset,
  ObservationKindToggles,
} from "./knowledge/preferences.js";
export { mergeExtraction } from "./knowledge/merge.js";
export type { MergeResult } from "./knowledge/merge.js";
export {
  CONNECTOR_SOURCE_TYPES,
  defaultVisibilityForType,
  MEETING_SOURCE_TYPE,
  PROFILE_SOURCE_TYPE,
} from "./knowledge/visibility.js";
export type { SourceVisibility } from "./knowledge/visibility.js";
export {
  composeProfileContext,
  ensureProfileDocs,
  ensureProfilePrivacy,
  listProfileHistory,
  loadProfile,
  loadProfileContext,
  loadProfileSection,
  PROFILE_DIR,
  PROFILE_SECTION_IDS,
  PROFILE_SECTIONS,
  profileSection,
  readProfileVersion,
  saveProfileSection,
  withProfile,
} from "./profile/profile-doc.js";
export type {
  Profile,
  ProfileSectionDef,
  ProfileSectionId,
  ProfileVersion,
} from "./profile/profile-doc.js";
export {
  draftProfileFromContext,
  draftProfileFromKnowledge,
  editProfileWithInstruction,
} from "./profile/profile-assistant.js";
export type { ProfileProposal } from "./profile/profile-assistant.js";
export { findDuplicateEntities } from "./knowledge/entity-resolution.js";
export type { DuplicateProposal } from "./knowledge/entity-resolution.js";
export { WikiWriter } from "./wiki/writer.js";
export type {
  WikiPageCheck,
  WikiPageIssue,
  WikiReconcileResult,
  WikiReconcileSkip,
  WikiRunHook,
  WikiRunSink,
  WikiRunStart,
} from "./wiki/writer.js";
export { WIKI_AGENTS_MD, writeWikiAgentDocs } from "./wiki/agent-readme.js";
export {
  DEFAULT_WIKI_SANDBOX_LIMITS,
  RunLimitTracker,
  WikiLimitExceededError,
  WikiPathEscapeError,
  assertInWorkspace,
  checkWorkspacePath,
  guardTools,
} from "./wiki/sandbox-guard.js";
export type { GuardAuditEvent, GuardViolation, WikiSandboxLimits } from "./wiki/sandbox-guard.js";
export { Vault } from "./vault/vault.js";
export type { NoteContents, NoteMeta } from "./vault/vault.js";
export { lintPage } from "./wiki/wiki-lint.js";
export type { IssueSeverity, LintIssue, PageLintResult } from "./wiki/wiki-lint.js";
export { healWiki } from "./wiki/self-healing.js";
export type { HealingReport } from "./wiki/self-healing.js";
export { JobQueue, SerialQueue, JobPriority, DEFAULT_PRIORITY } from "./jobs/queue.js";
export { Semaphore } from "./jobs/semaphore.js";
export { MeosEvents } from "./events.js";
export type { MeosEvent, MeosEventHandler, MeosEventMap } from "./events.js";
export { buildContextPack } from "./chat/retrieval.js";
export type { ContextPack, RetrievalOptions } from "./chat/retrieval.js";
export { classifyIntent } from "./chat/query-planner.js";
export type { QueryIntent } from "./chat/query-planner.js";
export { ChatService } from "./chat/chat.js";
export type { ChatResponseEvent } from "./chat/chat.js";
export { buildChatTools } from "./chat/tools.js";
export type { ChatTools, ChatToolDeps, TraversalGraph } from "./chat/tools.js";
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
export {
  clampConfidence,
  CONFIDENCE_CAP,
  initialConfidence,
  sourceQuality,
} from "./memory/confidence.js";
export { classifyMemoryTier, reclassifyMemoryTiers } from "./memory/memory-tiers.js";
export type { MemoryTier } from "./memory/memory-tiers.js";
export { expireStaleValidity } from "./memory/supersession.js";
export {
  ageInDays,
  DEFAULT_STALE_AFTER_DAYS,
  effectiveDateOf,
  formatAge,
  isStale,
  isUpcoming,
  STALE_AFTER_DAYS,
  staleAfterDays,
  temporalTag,
} from "./memory/temporal.js";
export type { TemporalClaim } from "./memory/temporal.js";
export { runRetention } from "./memory/retention.js";
export type { RetentionReport } from "./memory/retention.js";
export { runConsolidation } from "./memory/consolidate.js";
export type { ConsolidationReport } from "./memory/consolidate.js";
export { applyResolution, proposeResolution } from "./memory/resolution.js";
export type { ResolutionAction, ResolutionProposal } from "./memory/resolution.js";
export { crystallizeSession } from "./memory/crystallize.js";
export type { SessionCrystal } from "./memory/crystallize.js";
export * from "./connectors/index.js";
