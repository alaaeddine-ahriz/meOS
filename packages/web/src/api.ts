// Request/response types are owned by @meos/contracts (Zod schemas inferred to
// TS). The web app imports the TYPES only — it never imports the schemas or any
// server/core source — so the client and server cannot silently drift on shape.
// These re-exports preserve the names the rest of the web app already imports
// from `./api`.
import { isTauri } from "./lib/platform.js";
// The `ErrorCode` enum is a runtime export of @meos/contracts (a const object of
// stable string codes). Importing its *values* into the web client is allowed by
// the boundary rules — the client branches on these codes for typed recovery.
import { ErrorCode } from "@meos/contracts";
import type {
  ActivityEvent,
  AuditEntry,
  CalendarEvent,
  CalendarListEntry,
  CatalogConnector,
  CatalogKind,
  ChatEvent,
  CloudProvider,
  Contradiction,
  ContradictionProposal,
  Conversation,
  ConnectorAuth,
  ConnectorCatalog,
  ConnectorCoverage,
  ConnectorHealth,
  ConnectorKind,
  ConnectorKindStatus,
  ConnectorStatus,
  CoverageState,
  SourceHealth,
  Task,
  TaskList,
  DiffFile,
  DuplicateProposal,
  EntitySummary,
  EntityTypeName,
  ErrorCode as ErrorCodeType,
  ErrorEnvelope,
  GitCommit,
  GitCommitDetail,
  GitStatus,
  GraphLink,
  GraphNode,
  InboxItem,
  IngestJob,
  IngestMetrics,
  KnowledgePreferences,
  KnowledgePreset,
  LlmErrorKind,
  LlmProvider,
  LlmSettings,
  ObservationKindName,
  MeetingDetail,
  MeetingLink,
  MeetingObservation,
  MeetingSummary,
  Message,
  ModelListing,
  NoteContents,
  NoteMeta,
  ProfileData,
  ProfileProposal,
  ProfileSectionView,
  ProfileVersion,
  ProviderStatus,
  ResolutionAction,
  RuntimeHealth,
  SourceDiff,
  SourceRef,
  WatchedFolder,
  WikiGraph,
  WikiPage,
  WikiRun,
  WikiRunEvent,
  WikiRunEventKind,
} from "@meos/contracts";
// Response wrapper types (the exact JSON each endpoint returns) inferred from the
// contract Zod schemas and re-exported as types from @meos/contracts. The client
// binds every method's return type to one of these so it cannot drift from the
// server's response schema.
import type {
  ActivityResponse,
  AddFolderResponse,
  AgentModeResponse,
  AgentQueueResponse,
  ApplyProfileResponse,
  AuditResponse,
  AuthStartResponse,
  BackfillWikiResponse,
  ConsolidateResponse,
  ContradictionsResponse,
  CreateConversationResponse,
  DeleteNoteResponse,
  DigestResponse,
  DisconnectResponse,
  DismissDuplicateResponse,
  DuplicatesResponse,
  EndConversationResponse,
  GitAutoResponse,
  GitLogResponse,
  InboxResponse,
  IngestJobsResponse,
  KnowledgePreferencesResponse,
  ListCalendarEventsResponse,
  ListConversationsResponse,
  ListEntitiesResponse,
  ListFoldersResponse,
  ListMeetingsResponse,
  ListNotesResponse,
  ListSourcesResponse,
  LocalModelsResponse,
  MergeEntitiesResponse,
  MessagesResponse,
  OutputJsonResponse,
  ProfileAuditResponse,
  ProfileHistoryResponse,
  ProfilePrivacyResponse,
  ProfileProposalResponse,
  ProfileUploadResponse,
  RemoveFolderResponse,
  ReprocessMeetingResponse,
  ResetResponse,
  CancelJobResponse,
  ClearDeadLetterResponse,
  PauseResponse,
  RebuildSourceResponse,
  ResolveContradictionResponse,
  RetryDeadLetterResponse,
  RetryJobResponse,
  ReviewLinkResponse,
  RunEventsResponse,
  SearchResponse,
  SourceDetailResponse,
  SourceHealthResponse,
  SyncKindResponse,
  WikiGraphResponse,
} from "@meos/contracts";

export type {
  ActivityEvent,
  AgentModeResponse,
  AgentQueueResponse,
  AuditEntry,
  IndexedSource,
  IndexedEntityLink,
  RelatedSource,
  SourceDetail,
  CalendarEvent,
  CalendarListEntry,
  CatalogConnector,
  CatalogKind,
  ChatEvent,
  CloudProvider,
  Contradiction,
  ContradictionProposal,
  Conversation,
  ConnectorAuth,
  ConnectorCatalog,
  ConnectorCoverage,
  ConnectorHealth,
  ConnectorKind,
  ConnectorKindStatus,
  ConnectorStatus,
  CoverageState,
  SourceHealth,
  Task,
  TaskList,
  DiffFile,
  DuplicateProposal,
  EntitySummary,
  GitCommit,
  GitCommitDetail,
  GitStatus,
  GraphLink,
  GraphNode,
  EntityTypeName,
  InboxItem,
  IngestJob,
  IngestMetrics,
  KnowledgePreferences,
  KnowledgePreset,
  LlmErrorKind,
  LlmProvider,
  LlmSettings,
  ObservationKindName,
  MeetingDetail,
  MeetingLink,
  MeetingObservation,
  MeetingSummary,
  Message,
  ModelListing,
  NoteContents,
  NoteMeta,
  ProfileData,
  ProfileProposal,
  ProfileSectionView,
  ProfileVersion,
  ProviderStatus,
  ResolutionAction,
  RuntimeHealth,
  SourceDiff,
  SourceRef,
  WatchedFolder,
  WikiGraph,
  WikiPage,
  WikiRun,
  WikiRunEvent,
  WikiRunEventKind,
} from "@meos/contracts";

// In the browser the dev proxy / same-origin server handles /api; inside the
// Tauri shell the page is served from tauri:// so the API needs an absolute base.
const API_BASE = isTauri ? "http://127.0.0.1:4321" : "";

/** Re-export the stable error-code identifiers so callers can branch on them. */
export { ErrorCode };
export type { ErrorEnvelope };

/**
 * A typed client error mirroring the server's error envelope (`@meos/contracts`
 * `ErrorEnvelopeSchema`). Every failed `json()` call throws one of these, so UI
 * code can branch on `error.code` (e.g. show Settings on an UPSTREAM_ERROR) and
 * surface `error.message` directly — it is already user-facing. `requestId`
 * correlates the failure with the server log.
 */
export class ApiError extends Error {
  readonly code: ErrorCodeType | string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly recoverable: boolean;
  readonly status: number;

  constructor(status: number, envelope: Partial<ErrorEnvelope> & { message: string }) {
    super(envelope.message);
    this.name = "ApiError";
    this.status = status;
    this.code = envelope.code ?? ErrorCode.INTERNAL_ERROR;
    this.details = envelope.details;
    this.requestId = envelope.requestId;
    // 4xx are caller-fixable; default unknown shapes to the status class.
    this.recoverable = envelope.recoverable ?? (status >= 400 && status < 500);
  }
}

/**
 * Narrow an arbitrary parsed JSON body to the error envelope shape. The web
 * client imports contract TYPES only (never the Zod schema), so this hand-rolled
 * guard mirrors `ErrorEnvelopeSchema` without pulling a runtime schema — and
 * keeps the boundary (`web → @meos/contracts` types) intact.
 */
function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    typeof v.message === "string" &&
    typeof v.requestId === "string" &&
    typeof v.recoverable === "boolean"
  );
}

/**
 * Parse a non-OK response into a typed {@link ApiError}: read the JSON body,
 * validate it against the error-envelope shape, and throw. Bodies that aren't a
 * well-formed envelope (e.g. a proxy 502 HTML page) still throw an ApiError with
 * a best-effort message, so callers only ever catch one error type.
 */
async function throwApiError(response: Response): Promise<never> {
  const raw = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  if (isErrorEnvelope(parsed)) {
    throw new ApiError(response.status, parsed);
  }
  throw new ApiError(response.status, {
    code: ErrorCode.INTERNAL_ERROR,
    message: raw || response.statusText || `Request failed (${response.status})`,
  });
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API_BASE + input, init);
  if (!response.ok) {
    await throwApiError(response);
  }
  return response.json() as Promise<T>;
}

export const api = {
  listEntities: () => json<ListEntitiesResponse>("/api/wiki"),
  listSources: () => json<ListSourcesResponse>("/api/sources"),
  getSource: (id: number) => json<SourceDetailResponse>(`/api/sources/${id}`),
  // Source health dashboard (#87): the unified indexed/failed/skipped/pending +
  // last-sync + running-jobs + recent-failures overview across folders + connectors.
  getSourceHealth: () => json<SourceHealthResponse>("/api/source-health"),
  getWikiPage: (slug: string) => json<WikiPage>(`/api/wiki/${slug}`),
  getGraph: () => json<WikiGraphResponse>("/api/wiki/graph"),
  getInbox: () => json<InboxResponse>("/api/inbox"),
  listIngestJobs: () => json<IngestJobsResponse>("/api/ingest/jobs"),
  // Ingestion observability (#18): per-stage timings, queue throughput, recovery
  // counters, cost telemetry, and the active backpressure cap.
  getIngestMetrics: () => json<IngestMetrics>("/api/ingest/metrics"),
  getRuntimeHealth: () => json<RuntimeHealth>("/api/runtime"),
  retryIngestJob: (id: number) =>
    json<RetryJobResponse>(`/api/ingest/jobs/${id}/retry`, { method: "POST" }),
  // Bulk dead-letter controls for the Health tab (#98).
  retryDeadLetter: () =>
    json<RetryDeadLetterResponse>("/api/ingest/dead-letter/retry", { method: "POST" }),
  clearDeadLetter: () =>
    json<ClearDeadLetterResponse>("/api/ingest/dead-letter/clear", { method: "POST" }),
  // Per-job controls (#98).
  cancelIngestJob: (id: number) =>
    json<CancelJobResponse>(`/api/ingest/jobs/${id}/cancel`, { method: "POST" }),
  rebuildSource: (id: number) =>
    json<RebuildSourceResponse>(`/api/ingest/sources/${id}/rebuild`, { method: "POST" }),
  pauseIngest: () => json<PauseResponse>("/api/ingest/pause", { method: "POST" }),
  resumeIngest: () => json<PauseResponse>("/api/ingest/resume", { method: "POST" }),
  listFolders: () => json<ListFoldersResponse>("/api/settings/folders"),
  addFolder: (path: string) =>
    json<AddFolderResponse>("/api/settings/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  removeFolder: (id: number) =>
    json<RemoveFolderResponse>(`/api/settings/folders/${id}`, { method: "DELETE" }),
  resetEverything: () => json<ResetResponse>("/api/settings/reset", { method: "POST" }),
  // Knowledge preferences (#86): which entity types / observation kinds MeOS
  // focuses on. Unset on the server resolves to all-enabled.
  getKnowledgePreferences: () => json<KnowledgePreferencesResponse>("/api/settings/knowledge"),
  setKnowledgePreferences: (prefs: Partial<KnowledgePreferences>) =>
    json<KnowledgePreferencesResponse>("/api/settings/knowledge", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prefs),
    }),
  getLlmSettings: () => json<LlmSettings>("/api/settings/llm"),
  updateLlmSettings: (update: {
    provider: LlmProvider;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  }) =>
    json<LlmSettings>("/api/settings/llm", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    }),
  // Models available on a local OpenAI-compatible server. A failure surfaces as a
  // typed ApiError whose `message` is the server's friendly explanation (from the
  // error envelope), so Settings can show it directly.
  listLocalModels: async (baseUrl?: string): Promise<LocalModelsResponse> => {
    const query = baseUrl ? `?baseUrl=${encodeURIComponent(baseUrl)}` : "";
    const response = await fetch(`${API_BASE}/api/settings/llm/local/models${query}`);
    if (!response.ok) await throwApiError(response);
    const data = (await response.json().catch(() => ({}))) as Partial<LocalModelsResponse>;
    return { models: data.models ?? [] };
  },
  // Models a cloud provider's key can use, discovered live (with a curated
  // fallback). The unsaved key, if any, rides in a header so the picker can
  // refresh before saving without leaking the key into the URL.
  listProviderModels: async (provider: CloudProvider, apiKey?: string): Promise<ModelListing> => {
    const response = await fetch(`${API_BASE}/api/settings/llm/${provider}/models`, {
      headers: apiKey ? { "x-llm-api-key": apiKey } : undefined,
    });
    const data = (await response.json().catch(() => ({}))) as Partial<ModelListing> & {
      error?: string;
    };
    if (!response.ok) throw new Error(data.error || `Failed to list models (${response.status})`);
    return { models: data.models ?? [], source: data.source ?? "curated", error: data.error };
  },
  // Set (or clear, with an empty model) the reasoning-capable wiki-maintainer model.
  updateMaintainerModel: (update: { provider?: LlmProvider; model: string }) =>
    json<LlmSettings>("/api/settings/llm/maintainer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    }),
  // --- activity (live + replayed wiki-maintainer transcripts) ---
  getActivity: () => json<ActivityResponse>("/api/activity"),
  getRunEvents: (id: number) => json<RunEventsResponse>(`/api/activity/${id}/events`),
  // --- vault (the user's hand-written notes) ---
  listNotes: () => json<ListNotesResponse>("/api/vault"),
  getNote: (path: string) => json<NoteContents>(`/api/vault/note?path=${encodeURIComponent(path)}`),
  createNote: (path: string) =>
    json<NoteMeta>("/api/vault/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  saveNote: (path: string, markdown: string) =>
    json<NoteMeta>("/api/vault/note", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, markdown }),
    }),
  deleteNote: (path: string) =>
    json<DeleteNoteResponse>(`/api/vault/note?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),
  renameNote: (from: string, to: string) =>
    json<NoteMeta>("/api/vault/note/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    }),

  // Meeting notes (#26): trusted, auto-linked, citable sources.
  listMeetings: () => json<ListMeetingsResponse>("/api/meetings"),
  getMeeting: (id: number) => json<MeetingDetail>(`/api/meetings/${id}`),
  createMeeting: (body: {
    title: string;
    date?: string | null;
    attendees: string[];
    content: string;
  }) =>
    json<MeetingDetail>("/api/meetings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  updateMeeting: (
    id: number,
    body: { title: string; date?: string | null; attendees: string[]; content: string },
  ) =>
    json<MeetingDetail>(`/api/meetings/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  reprocessMeeting: (id: number) =>
    json<ReprocessMeetingResponse>(`/api/meetings/${id}/reprocess`, {
      method: "POST",
    }),
  reviewMeetingLink: (id: number, linkId: number, status: "accepted" | "rejected") =>
    json<ReviewLinkResponse>(`/api/meetings/${id}/links/${linkId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }),

  listConversations: () => json<ListConversationsResponse>("/api/conversations"),
  getMessages: (id: number) => json<MessagesResponse>(`/api/conversations/${id}/messages`),
  getLatestDigest: () => json<DigestResponse>("/api/digest/latest"),
  runConsolidation: () => json<ConsolidateResponse>("/api/jobs/consolidate", { method: "POST" }),
  getGitStatus: () => json<GitStatus>("/api/settings/git"),
  initGit: () => json<GitStatus>("/api/settings/git/init", { method: "POST" }),
  setGitRemote: (url: string) =>
    json<GitStatus>("/api/settings/git/remote", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  setGitAutoSync: (enabled: boolean) =>
    json<GitAutoResponse>("/api/settings/git/auto", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  gitSync: () => json<GitStatus>("/api/settings/git/sync", { method: "POST" }),
  getGitLog: (limit = 50) => json<GitLogResponse>(`/api/settings/git/log?limit=${limit}`),
  getGitCommit: (hash: string) => json<GitCommitDetail>(`/api/settings/git/commit/${hash}`),
  // --- wiki maintenance mode (in-app vs external coding-agent) ---
  getWikiMode: () => json<AgentModeResponse>("/api/wiki/agent/mode"),
  setWikiMode: (mode: AgentModeResponse["mode"]) =>
    json<AgentModeResponse>("/api/wiki/agent/mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }),
  getWikiAgentQueue: () => json<AgentQueueResponse>("/api/wiki/agent/queue"),
  getSourceDiff: (sourceId: number) => json<SourceDiff>(`/api/sources/${sourceId}/diff`),
  // --- connectors (multi-provider: every method takes the provider id) ---
  // The connector catalog: every registered connector with its kinds, display
  // names, logos and capabilities. Drives all connector UI so it's catalog- not
  // Google-driven. Stable for the life of the app.
  getConnectorCatalog: () => json<ConnectorCatalog>("/api/connectors/catalog"),
  getConnectors: () => json<ConnectorStatus>("/api/connectors"),
  // Save a connector's credentials. OAuth connectors send the OAuth client
  // (clientId/clientSecret); basic connectors send their `auth.fields` values.
  saveCredentials: (provider: string, fields: Record<string, string>) =>
    json<ConnectorStatus>(`/api/connectors/${provider}/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    }),
  startAuth: (provider: string) =>
    json<AuthStartResponse>(`/api/connectors/${provider}/auth/start`, { method: "POST" }),
  configureConnectorKind: (
    provider: string,
    kind: ConnectorKind,
    config: {
      enabled?: boolean;
      intervalMinutes?: number;
      coverageWindow?: string;
      contentMode?: string;
      enabledCalendars?: string[];
      mode?: "index" | "wiki";
      includeLabels?: string[];
      excludeLabels?: string[];
      enabledTaskLists?: string[];
      reset?: boolean;
    },
  ) =>
    json<ConnectorStatus>(`/api/connectors/${provider}/${kind}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    }),
  syncConnectorKind: (provider: string, kind: ConnectorKind) =>
    json<SyncKindResponse>(`/api/connectors/${provider}/${kind}/sync`, { method: "POST" }),
  // The provider's calendars, for the multi-calendar picker (#68).
  listCalendars: (provider: string) =>
    json<{ calendars: CalendarListEntry[] }>(`/api/connectors/${provider}/calendars`),
  disconnect: (provider: string) =>
    json<DisconnectResponse>(`/api/connectors/${provider}`, { method: "DELETE" }),
  // Tasks (read + write). List task lists, and create / complete a task.
  listTaskLists: (provider: string) =>
    json<{ lists: TaskList[] }>(`/api/connectors/${provider}/tasks/lists`),
  createTask: (
    provider: string,
    input: { taskListId?: string; title: string; notes?: string; due?: string },
  ) =>
    json<{ task: Task }>(`/api/connectors/${provider}/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  completeTask: (provider: string, taskId: string, taskListId: string, completed = true) =>
    json<{ task: Task }>(
      `/api/connectors/${provider}/tasks/${encodeURIComponent(taskId)}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskListId, completed }),
      },
    ),
  // Synced calendar events for the `@`-mention picker (empty if not connected).
  listCalendarEvents: (q = "", limit = 25) =>
    json<ListCalendarEventsResponse>(
      `/api/calendar/events?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  getDuplicates: () => json<DuplicatesResponse>("/api/entities/duplicates"),
  mergeEntities: (loserId: number, winnerId: number) =>
    json<MergeEntitiesResponse>("/api/entities/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loserId, winnerId }),
    }),
  dismissDuplicate: (aId: number, bId: number) =>
    json<DismissDuplicateResponse>("/api/entities/dismiss-duplicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aId, bId }),
    }),
  getContradictions: () => json<ContradictionsResponse>("/api/contradictions"),
  resolveContradiction: (id: number, action: ResolutionAction) =>
    json<ResolveContradictionResponse>(`/api/contradictions/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }),
  getOutput: (
    mode:
      | "decision-brief"
      | "contradiction-report"
      | "timeline"
      | "dependency-graph"
      | "meeting-brief",
    entity?: string,
  ) =>
    json<OutputJsonResponse>(
      `/api/outputs/${mode}?format=json${entity ? `&entity=${encodeURIComponent(entity)}` : ""}`,
    ),

  // --- profile (the user lens) ---
  getProfile: () => json<ProfileData>("/api/profile"),
  saveProfileSection: (id: string, content: string) =>
    json<ProfileData>(`/api/profile/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }),
  applyProfile: (profile: Record<string, string>) =>
    json<ApplyProfileResponse>("/api/profile/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile }),
    }),
  uploadProfileDocs: async (files: File[]): Promise<ProfileUploadResponse> => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    const response = await fetch(`${API_BASE}/api/profile/upload`, { method: "POST", body: form });
    if (!response.ok) await throwApiError(response);
    return response.json() as Promise<ProfileUploadResponse>;
  },
  draftProfile: () => json<ProfileProposalResponse>("/api/profile/draft", { method: "POST" }),
  draftProfileFromWiki: () =>
    json<ProfileProposalResponse>("/api/profile/draft-from-wiki", { method: "POST" }),
  editProfile: (instruction: string, useUploaded = false) =>
    json<ProfileProposalResponse>("/api/profile/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction, useUploaded }),
    }),
  getProfileHistory: (id: string) => json<ProfileHistoryResponse>(`/api/profile/${id}/history`),
  restoreProfileVersion: (id: string, version: string) =>
    json<ProfileData>(`/api/profile/${id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version }),
    }),
  getProfileAudit: () => json<ProfileAuditResponse>("/api/profile/audit"),
  setProfilePrivacy: (sync: boolean) =>
    json<ProfilePrivacyResponse>("/api/profile/privacy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sync }),
    }),
};

export async function* streamChat(
  message: string,
  conversationId?: number,
  agent?: boolean,
  model?: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const response = await fetch(API_BASE + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, conversationId, agent, model }),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`chat failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.trim();
      if (line.startsWith("data: ")) {
        yield JSON.parse(line.slice(6)) as ChatEvent;
      }
    }
  }
}

/**
 * Subscribe to the live wiki-maintainer feed. Yields every run's activity
 * (start, transcript deltas, finish) until `signal` aborts. Mirrors streamChat's
 * SSE frame parsing; the caller groups events by `runId`.
 */
export async function* streamActivity(signal?: AbortSignal): AsyncGenerator<ActivityEvent> {
  const response = await fetch(API_BASE + "/api/activity/stream", { signal });
  if (!response.ok || !response.body) {
    throw new Error(`activity stream failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.trim();
      // Skip heartbeat comments (": ping"); only data frames carry events.
      if (line.startsWith("data: ")) {
        yield JSON.parse(line.slice(6)) as ActivityEvent;
      }
    }
  }
}
