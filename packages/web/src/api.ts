export interface EntitySummary {
  id: number;
  type: string;
  name: string;
  slug: string;
  summary: string | null;
  updatedAt: string;
}

export interface SourceRef {
  id: number;
  title: string;
  path: string | null;
}

export interface WikiPage {
  entity: EntitySummary & { stale: boolean };
  markdown: string | null;
  relationships: Array<{ label: string; direction: "in" | "out"; other: string }>;
  sources: SourceRef[];
  observations: Array<{
    text: string;
    confidence: number;
    tier: string;
    recordedAt: string;
    lastConfirmedAt: string;
  }>;
}

export interface GraphNode {
  id: number;
  type: string;
  name: string;
  slug: string;
}

export interface GraphLink {
  from: number;
  to: number;
  label: string;
}

export interface WikiGraph {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface InboxItem {
  id: number;
  /** The ingested document, once parsing has created one. Null while queued. */
  source_id: number | null;
  title: string;
  status: string;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: number;
  title: string | null;
  created_at: string;
}

export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  /** Documents the reply drew on; persisted server-side, absent on pending messages. */
  sources?: SourceRef[];
}

export interface WatchedFolder {
  id: number;
  path: string;
}

export type LlmProvider = "anthropic" | "openai" | "google" | "local";

export interface LlmSettings {
  provider: LlmProvider;
  models: Record<"anthropic" | "openai" | "google", string[]>;
  providers: {
    anthropic: { model: string; hasKey: boolean };
    openai: { model: string; hasKey: boolean };
    google: { model: string; hasKey: boolean };
    local: { model: string; baseUrl: string };
  };
}

export interface GitStatus {
  initialized: boolean;
  branch: string | null;
  remote: string | null;
  dirty: number;
  ahead: number | null;
  behind: number | null;
  lastCommit: string | null;
  autoSync: boolean;
}

export interface GitCommit {
  hash: string;
  subject: string;
  body: string;
  relativeDate: string;
  files: number;
}

export interface GitCommitDetail {
  hash: string;
  subject: string;
  body: string;
  patch: string;
}

/** One wiki page touched within a document's commit. */
export interface DiffFile {
  path: string;
  kind: "created" | "updated";
  entityName: string | null;
  entitySlug: string | null;
}

export interface SourceDiff {
  source: SourceRef;
  commits: Array<{
    hash: string;
    subject: string;
    committedAt: string;
    files: DiffFile[];
    patch: string;
  }>;
}

export interface DuplicateProposal {
  aId: number;
  bId: number;
  aName: string;
  bName: string;
  type: string;
  reasons: string[];
  score: number;
  suggestedWinnerId: number;
}

export type ResolutionAction = "supersede_a" | "supersede_b" | "keep_both" | "context_specific";

export interface ContradictionProposal {
  suggested: ResolutionAction;
  rationale: string;
  margin: number;
}

export interface Contradiction {
  id: number;
  note: string | null;
  entity_name: string;
  text_a: string;
  text_b: string;
  created_at: string;
  proposal?: ContradictionProposal;
}

export interface ProfileSectionView {
  id: string;
  title: string;
  description: string;
  placeholder: string;
  content: string;
}

export interface ProfileData {
  sections: ProfileSectionView[];
  gitSync: boolean;
}

/** A reviewable AI proposal: the full proposed profile keyed by section id + a note. */
export interface ProfileProposal {
  profile: Record<string, string>;
  summary: string;
}

export interface ProfileVersion {
  version: string;
  savedAt: string;
}

export interface AuditEntry {
  id: number;
  op: string;
  detail: string | null;
  created_at: string;
}

/** Coarse cause of an LLM failure; mirrors core's LlmErrorKind. */
export type LlmErrorKind =
  | "auth"
  | "credits"
  | "rate_limit"
  | "timeout"
  | "connection"
  | "model"
  | "bad_response"
  | "bad_request"
  | "server"
  | "unknown";

export type ChatEvent =
  | { type: "start"; conversationId: number }
  | { type: "sources"; sources: SourceRef[] }
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string; kind?: LlmErrorKind };

import { isTauri } from "./lib/platform.js";

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
  ingestText: (text: string) =>
    json<{ inboxItemId: number }>("/api/ingest/text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
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
  updateLlmSettings: (update: { provider: LlmProvider; model?: string; apiKey?: string; baseUrl?: string }) =>
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
  getOutput: (mode: "decision-brief" | "contradiction-report" | "timeline" | "dependency-graph" | "meeting-brief", entity?: string) =>
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
  uploadProfileDocs: async (files: File[]): Promise<{ proposal: ProfileProposal; documents: string[] }> => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    const response = await fetch(`${API_BASE}/api/profile/upload`, { method: "POST", body: form });
    const data = (await response.json().catch(() => ({}))) as
      | { proposal: ProfileProposal; documents: string[] }
      | { error?: string };
    if (!response.ok) throw new Error((data as { error?: string }).error || `Upload failed (${response.status})`);
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
  getProfileHistory: (id: string) => json<{ versions: ProfileVersion[] }>(`/api/profile/${id}/history`),
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

export async function* streamChat(message: string, conversationId?: number): AsyncGenerator<ChatEvent> {
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
