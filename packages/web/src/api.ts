// Request/response types are owned by @meos/contracts (Zod schemas inferred to
// TS). The web app imports the TYPES only — it never imports the schemas or any
// server/core source — so the client and server cannot silently drift on shape.
// These re-exports preserve the names the rest of the web app already imports
// from `./api`.
import { isTauri } from "./lib/platform.js";
import type {
  ActivityEvent,
  AuditEntry,
  ChatEvent,
  CloudProvider,
  Contradiction,
  ContradictionProposal,
  Conversation,
  ConnectorKind,
  ConnectorKindStatus,
  ConnectorStatus,
  DiffFile,
  DuplicateProposal,
  EntitySummary,
  GitCommit,
  GitCommitDetail,
  GitStatus,
  GraphLink,
  GraphNode,
  InboxItem,
  IngestJob,
  IngestMetrics,
  LlmErrorKind,
  LlmProvider,
  LlmSettings,
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

export type {
  ActivityEvent,
  AuditEntry,
  ChatEvent,
  CloudProvider,
  Contradiction,
  ContradictionProposal,
  Conversation,
  ConnectorKind,
  ConnectorKindStatus,
  ConnectorStatus,
  DiffFile,
  DuplicateProposal,
  EntitySummary,
  GitCommit,
  GitCommitDetail,
  GitStatus,
  GraphLink,
  GraphNode,
  InboxItem,
  IngestJob,
  IngestMetrics,
  LlmErrorKind,
  LlmProvider,
  LlmSettings,
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

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API_BASE + input, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status}: ${body || response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  listEntities: () => json<{ entities: EntitySummary[] }>("/api/wiki"),
  getWikiPage: (slug: string) => json<WikiPage>(`/api/wiki/${slug}`),
  getGraph: () => json<WikiGraph>("/api/wiki/graph"),
  getInbox: () => json<{ queuePending: number; items: InboxItem[] }>("/api/inbox"),
  listIngestJobs: () => json<{ jobs: IngestJob[] }>("/api/ingest/jobs"),
  // Ingestion observability (#18): per-stage timings, queue throughput, recovery
  // counters, cost telemetry, and the active backpressure cap.
  getIngestMetrics: () => json<IngestMetrics>("/api/ingest/metrics"),
  getRuntimeHealth: () => json<RuntimeHealth>("/api/runtime"),
  retryIngestJob: (id: number) =>
    json<{ retried: boolean }>(`/api/ingest/jobs/${id}/retry`, { method: "POST" }),
  listFolders: () => json<{ folders: WatchedFolder[] }>("/api/settings/folders"),
  addFolder: (path: string) =>
    json<{ folder: WatchedFolder }>("/api/settings/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  removeFolder: (id: number) =>
    json<{ removed: boolean }>(`/api/settings/folders/${id}`, { method: "DELETE" }),
  resetEverything: () => json<{ ok: boolean }>("/api/settings/reset", { method: "POST" }),
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
  // Models available on a local OpenAI-compatible server. Surfaces the server's
  // friendly error message (rather than the raw status) so Settings can show it.
  listLocalModels: async (baseUrl?: string): Promise<{ models: string[] }> => {
    const query = baseUrl ? `?baseUrl=${encodeURIComponent(baseUrl)}` : "";
    const response = await fetch(`${API_BASE}/api/settings/llm/local/models${query}`);
    const data = (await response.json().catch(() => ({}))) as { models?: string[]; error?: string };
    if (!response.ok) throw new Error(data.error || `Failed to list models (${response.status})`);
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
  getActivity: () => json<{ runs: WikiRun[] }>("/api/activity"),
  getRunEvents: (id: number) =>
    json<{ run: WikiRun; events: WikiRunEvent[] }>(`/api/activity/${id}/events`),
  // --- vault (the user's hand-written notes) ---
  listNotes: () => json<{ notes: NoteMeta[] }>("/api/vault"),
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
    json<{ deleted: boolean }>(`/api/vault/note?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),
  renameNote: (from: string, to: string) =>
    json<NoteMeta>("/api/vault/note/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    }),

  // Meeting notes (#26): trusted, auto-linked, citable sources.
  listMeetings: () => json<{ meetings: MeetingSummary[] }>("/api/meetings"),
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
    json<{ sourceId: number; status: string }>(`/api/meetings/${id}/reprocess`, {
      method: "POST",
    }),
  reviewMeetingLink: (id: number, linkId: number, status: "accepted" | "rejected") =>
    json<{ updated: boolean }>(`/api/meetings/${id}/links/${linkId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }),

  listConversations: () => json<{ conversations: Conversation[] }>("/api/conversations"),
  getMessages: (id: number) => json<{ messages: Message[] }>(`/api/conversations/${id}/messages`),
  getLatestDigest: () => json<{ date: string; content: string }>("/api/digest/latest"),
  runConsolidation: () => json<{ started: boolean }>("/api/jobs/consolidate", { method: "POST" }),
  getGitStatus: () => json<GitStatus>("/api/settings/git"),
  initGit: () => json<GitStatus>("/api/settings/git/init", { method: "POST" }),
  setGitRemote: (url: string) =>
    json<GitStatus>("/api/settings/git/remote", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  setGitAutoSync: (enabled: boolean) =>
    json<{ autoSync: boolean }>("/api/settings/git/auto", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  gitSync: () => json<GitStatus>("/api/settings/git/sync", { method: "POST" }),
  getGitLog: (limit = 50) => json<{ commits: GitCommit[] }>(`/api/settings/git/log?limit=${limit}`),
  getGitCommit: (hash: string) => json<GitCommitDetail>(`/api/settings/git/commit/${hash}`),
  getSourceDiff: (sourceId: number) => json<SourceDiff>(`/api/sources/${sourceId}/diff`),
  // --- connectors (Google Contacts / Calendar / Gmail) ---
  getConnectors: () => json<ConnectorStatus>("/api/connectors"),
  saveGoogleCredentials: (clientId: string, clientSecret: string) =>
    json<ConnectorStatus>("/api/connectors/google/credentials", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    }),
  startGoogleAuth: () =>
    json<{ url: string }>("/api/connectors/google/auth/start", { method: "POST" }),
  configureConnectorKind: (
    kind: ConnectorKind,
    config: { enabled?: boolean; intervalMinutes?: number },
  ) =>
    json<ConnectorStatus>(`/api/connectors/google/${kind}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    }),
  syncConnectorKind: (kind: ConnectorKind) =>
    json<{ syncing: boolean }>(`/api/connectors/google/${kind}/sync`, { method: "POST" }),
  disconnectGoogle: () =>
    json<{ disconnected: boolean }>("/api/connectors/google", { method: "DELETE" }),
  getDuplicates: () => json<{ duplicates: DuplicateProposal[] }>("/api/entities/duplicates"),
  mergeEntities: (loserId: number, winnerId: number) =>
    json<{ merged: boolean }>("/api/entities/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loserId, winnerId }),
    }),
  dismissDuplicate: (aId: number, bId: number) =>
    json<{ dismissed: boolean }>("/api/entities/dismiss-duplicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aId, bId }),
    }),
  getContradictions: () => json<{ contradictions: Contradiction[] }>("/api/contradictions"),
  resolveContradiction: (id: number, action: ResolutionAction) =>
    json<{ resolved: boolean }>(`/api/contradictions/${id}/resolve`, {
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
    json<{ markdown: string }>(
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
    json<ProfileData & { applied: string[] }>("/api/profile/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile }),
    }),
  uploadProfileDocs: async (
    files: File[],
  ): Promise<{ proposal: ProfileProposal; documents: string[] }> => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    const response = await fetch(`${API_BASE}/api/profile/upload`, { method: "POST", body: form });
    const data = (await response.json().catch(() => ({}))) as
      | { proposal: ProfileProposal; documents: string[] }
      | { error?: string };
    if (!response.ok)
      throw new Error((data as { error?: string }).error || `Upload failed (${response.status})`);
    return data as { proposal: ProfileProposal; documents: string[] };
  },
  draftProfile: () => json<{ proposal: ProfileProposal }>("/api/profile/draft", { method: "POST" }),
  draftProfileFromWiki: () =>
    json<{ proposal: ProfileProposal }>("/api/profile/draft-from-wiki", { method: "POST" }),
  editProfile: (instruction: string, useUploaded = false) =>
    json<{ proposal: ProfileProposal }>("/api/profile/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction, useUploaded }),
    }),
  getProfileHistory: (id: string) =>
    json<{ versions: ProfileVersion[] }>(`/api/profile/${id}/history`),
  restoreProfileVersion: (id: string, version: string) =>
    json<ProfileData>(`/api/profile/${id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version }),
    }),
  getProfileAudit: () => json<{ entries: AuditEntry[] }>("/api/profile/audit"),
  setProfilePrivacy: (sync: boolean) =>
    json<{ gitSync: boolean }>("/api/profile/privacy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sync }),
    }),
};

export async function* streamChat(
  message: string,
  conversationId?: number,
): AsyncGenerator<ChatEvent> {
  const response = await fetch(API_BASE + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, conversationId }),
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
