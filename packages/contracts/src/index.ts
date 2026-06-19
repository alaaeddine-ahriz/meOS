/**
 * @meos/contracts — the shared, runtime-agnostic API contract for meOS.
 *
 * Zod schemas + their inferred TypeScript types for every public HTTP endpoint
 * the server exposes. The server (`@meos/server`) imports the schemas to
 * validate requests and shape responses; the web client (`@meos/web`) imports
 * the inferred TYPES (via `z.infer`) so the two cannot silently drift on shape.
 *
 * This package depends only on `zod`, keeping the dependency graph acyclic:
 * `web → @meos/contracts` (types) and `server → @meos/contracts` (schemas).
 */
export * from "./error.js";

// Shared primitives.
export * from "./schemas/common.js";

// Route-grouped schemas, re-exported under a namespace per module so callers can
// write `wiki.WikiPageResponse`, and the most commonly shared types are also
// re-exported directly below for ergonomic `z.infer` consumption in the client.
export * as ingest from "./schemas/ingest.js";
export * as meetings from "./schemas/meetings.js";
export * as wiki from "./schemas/wiki.js";
export * as wikiAgent from "./schemas/wiki-agent.js";
export * as staleFacts from "./schemas/stale-facts.js";
export * as vault from "./schemas/vault.js";
export * as chat from "./schemas/chat.js";
export * as activity from "./schemas/activity.js";
export * as digest from "./schemas/digest.js";
export * as outputs from "./schemas/outputs.js";
export * as profile from "./schemas/profile.js";
export * as settings from "./schemas/settings.js";
export * as preferences from "./schemas/preferences.js";
export * as connectors from "./schemas/connectors.js";
export * as sources from "./schemas/sources.js";
export * as sourceHealth from "./schemas/source-health.js";
export * as calendar from "./schemas/calendar.js";
export * as git from "./schemas/git.js";
export * as runtime from "./schemas/runtime.js";

// --- Directly re-exported inferred TYPES, for the web client signatures. ---
export type { EntitySummary, SourceRef, GraphNode, GraphLink } from "./schemas/common.js";
export type {
  InboxItem,
  SourceDiff,
  DiffFile,
  IngestJob,
  IngestJobState,
  IngestQueueMetrics,
  IngestStageMetric,
  IngestRecoveryMetrics,
  IngestCostMetric,
  IngestMetrics,
} from "./schemas/ingest.js";
export type { WikiPage, WikiGraph, DuplicateProposal } from "./schemas/wiki.js";
export type {
  MeetingSummary,
  MeetingObservation,
  MeetingLink,
  MeetingDetail,
} from "./schemas/meetings.js";
export type { StaleFact, StaleFacts, RevisionStatus } from "./schemas/stale-facts.js";
export type { NoteMeta, NoteContents } from "./schemas/vault.js";
export type { Conversation, Message, ChatEvent, LlmErrorKind } from "./schemas/chat.js";
export type { WikiRun, WikiRunEvent, WikiRunEventKind, ActivityEvent } from "./schemas/activity.js";
export type {
  ResolutionAction,
  Contradiction,
  ContradictionProposal,
  AuditEntry,
} from "./schemas/digest.js";
export type { OutputMode } from "./schemas/outputs.js";
export type {
  ProfileSectionView,
  ProfileData,
  ProfileProposal,
  ProfileVersion,
} from "./schemas/profile.js";
export type {
  LlmProvider,
  CloudProvider,
  LlmSettings,
  ModelListing,
  WatchedFolder,
} from "./schemas/settings.js";
export type {
  EntityTypeName,
  ObservationKindName,
  KnowledgePreset,
  KnowledgePreferences,
} from "./schemas/preferences.js";
export type {
  AuthField,
  CalendarListEntry,
  CatalogConnector,
  CatalogKind,
  ConnectorAuth,
  ConnectorCatalog,
  ConnectorCoverage,
  ConnectorKind,
  ConnectorKindStatus,
  ConnectorStatus,
  CoverageState,
  CoverageWindow,
  GmailContentMode,
  IndexMode,
  KindCapabilities,
  ProviderStatus,
  Task,
  TaskList,
} from "./schemas/connectors.js";
export type {
  HealthLabel,
  SourceCounts,
  LocalFoldersHealth,
  ConnectorHealth,
  ConnectorAccountHealth,
  ConnectorsHealth,
  RunningJob,
  RecentFailure,
  PipelineHealth,
  SkippedType,
  SourceHealth,
} from "./schemas/source-health.js";
export type {
  IndexedSource,
  IndexedEntityLink,
  RelatedSource,
  SourceDetail,
} from "./schemas/sources.js";
export type { CalendarEvent } from "./schemas/calendar.js";
export type { GitStatus, GitCommit, GitCommitDetail } from "./schemas/git.js";
export type { WorkerStatus, WorkerHealth, RuntimeHealth, QueueDepth } from "./schemas/runtime.js";

// --- Inferred response-envelope TYPES, one per endpoint, for the web client. ---
// These are the exact JSON shapes each route returns. The typed client binds
// every method's return type to one of these so the client and the server's
// per-route response schema cannot silently drift. (Type-only: importing these
// never pulls a runtime schema into the web bundle.)
import type { z } from "zod";
import type * as activitySchemas from "./schemas/activity.js";
import type * as calendarSchemas from "./schemas/calendar.js";
import type * as chatSchemas from "./schemas/chat.js";
import type * as connectorsSchemas from "./schemas/connectors.js";
import type * as digestSchemas from "./schemas/digest.js";
import type * as gitSchemas from "./schemas/git.js";
import type * as ingestSchemas from "./schemas/ingest.js";
import type * as meetingsSchemas from "./schemas/meetings.js";
import type * as outputsSchemas from "./schemas/outputs.js";
import type * as preferencesSchemas from "./schemas/preferences.js";
import type * as profileSchemas from "./schemas/profile.js";
import type * as settingsSchemas from "./schemas/settings.js";
import type * as sourceHealthSchemas from "./schemas/source-health.js";
import type * as sourcesSchemas from "./schemas/sources.js";
import type * as vaultSchemas from "./schemas/vault.js";
import type * as wikiSchemas from "./schemas/wiki.js";
import type * as wikiAgentSchemas from "./schemas/wiki-agent.js";

export type AgentQueueResponse = z.infer<typeof wikiAgentSchemas.AgentQueueResponse>;
export type AgentContextResponse = z.infer<typeof wikiAgentSchemas.AgentContextResponse>;
export type AgentCheckResponse = z.infer<typeof wikiAgentSchemas.AgentCheckResponse>;
export type AgentWriteResponse = z.infer<typeof wikiAgentSchemas.AgentWriteResponse>;
export type AgentCommitResponse = z.infer<typeof wikiAgentSchemas.AgentCommitResponse>;
export type AgentModeResponse = z.infer<typeof wikiAgentSchemas.AgentModeResponse>;

export type ListEntitiesResponse = z.infer<typeof wikiSchemas.ListEntitiesResponse>;
export type WikiGraphResponse = z.infer<typeof wikiSchemas.WikiGraphResponse>;
export type DuplicatesResponse = z.infer<typeof wikiSchemas.DuplicatesResponse>;
export type MergeEntitiesResponse = z.infer<typeof wikiSchemas.MergeEntitiesResponse>;
export type DismissDuplicateResponse = z.infer<typeof wikiSchemas.DismissDuplicateResponse>;
export type BackfillWikiResponse = z.infer<typeof wikiSchemas.BackfillWikiResponse>;

export type InboxResponse = z.infer<typeof ingestSchemas.InboxResponse>;
export type IngestJobsResponse = z.infer<typeof ingestSchemas.IngestJobsResponse>;
export type RetryJobResponse = z.infer<typeof ingestSchemas.RetryJobResponse>;
export type RetryDeadLetterResponse = z.infer<typeof ingestSchemas.RetryDeadLetterResponse>;
export type ClearDeadLetterResponse = z.infer<typeof ingestSchemas.ClearDeadLetterResponse>;
export type CancelJobResponse = z.infer<typeof ingestSchemas.CancelJobResponse>;
export type RebuildSourceResponse = z.infer<typeof ingestSchemas.RebuildSourceResponse>;
export type PauseResponse = z.infer<typeof ingestSchemas.PauseResponse>;
export type UploadResponse = z.infer<typeof ingestSchemas.UploadResponse>;

export type ListMeetingsResponse = z.infer<typeof meetingsSchemas.ListMeetingsResponse>;
export type ReviewLinkResponse = z.infer<typeof meetingsSchemas.ReviewLinkResponse>;
export type ReprocessMeetingResponse = z.infer<typeof meetingsSchemas.ReprocessMeetingResponse>;

export type ListNotesResponse = z.infer<typeof vaultSchemas.ListNotesResponse>;
export type DeleteNoteResponse = z.infer<typeof vaultSchemas.DeleteNoteResponse>;

export type CreateConversationResponse = z.infer<typeof chatSchemas.CreateConversationResponse>;
export type ListConversationsResponse = z.infer<typeof chatSchemas.ListConversationsResponse>;
export type MessagesResponse = z.infer<typeof chatSchemas.MessagesResponse>;
export type EndConversationResponse = z.infer<typeof chatSchemas.EndConversationResponse>;
export type SearchResponse = z.infer<typeof chatSchemas.SearchResponse>;

export type ActivityResponse = z.infer<typeof activitySchemas.ActivityResponse>;
export type RunEventsResponse = z.infer<typeof activitySchemas.RunEventsResponse>;

export type DigestResponse = z.infer<typeof digestSchemas.DigestResponse>;
export type ConsolidateResponse = z.infer<typeof digestSchemas.ConsolidateResponse>;
export type ContradictionsResponse = z.infer<typeof digestSchemas.ContradictionsResponse>;
export type ResolveContradictionResponse = z.infer<
  typeof digestSchemas.ResolveContradictionResponse
>;
export type AuditResponse = z.infer<typeof digestSchemas.AuditResponse>;

export type OutputJsonResponse = z.infer<typeof outputsSchemas.OutputJsonResponse>;

export type ApplyProfileResponse = z.infer<typeof profileSchemas.ApplyProfileResponse>;
export type ProfileUploadResponse = z.infer<typeof profileSchemas.ProfileUploadResponse>;
export type ProfileProposalResponse = z.infer<typeof profileSchemas.ProfileProposalResponse>;
export type ProfileHistoryResponse = z.infer<typeof profileSchemas.ProfileHistoryResponse>;
export type ProfileAuditResponse = z.infer<typeof profileSchemas.ProfileAuditResponse>;
export type ProfilePrivacyResponse = z.infer<typeof profileSchemas.ProfilePrivacyResponse>;

export type LocalModelsResponse = z.infer<typeof settingsSchemas.LocalModelsResponse>;
export type ListFoldersResponse = z.infer<typeof settingsSchemas.ListFoldersResponse>;
export type AddFolderResponse = z.infer<typeof settingsSchemas.AddFolderResponse>;
export type RemoveFolderResponse = z.infer<typeof settingsSchemas.RemoveFolderResponse>;
export type ResetResponse = z.infer<typeof settingsSchemas.ResetResponse>;

export type KnowledgePreferencesResponse = z.infer<
  typeof preferencesSchemas.KnowledgePreferencesSchema
>;

export type AuthStartResponse = z.infer<typeof connectorsSchemas.AuthStartResponse>;
export type SyncKindResponse = z.infer<typeof connectorsSchemas.SyncKindResponse>;
export type DisconnectResponse = z.infer<typeof connectorsSchemas.DisconnectResponse>;

export type ListSourcesResponse = z.infer<typeof sourcesSchemas.ListSourcesResponse>;
export type SourceDetailResponse = z.infer<typeof sourcesSchemas.SourceDetailResponse>;

export type SourceHealthResponse = z.infer<typeof sourceHealthSchemas.SourceHealthResponse>;

export type ListCalendarEventsResponse = z.infer<typeof calendarSchemas.ListCalendarEventsResponse>;

export type GitAutoResponse = z.infer<typeof gitSchemas.GitAutoResponse>;
export type GitLogResponse = z.infer<typeof gitSchemas.GitLogResponse>;
