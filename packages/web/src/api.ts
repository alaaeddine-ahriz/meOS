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

export interface InboxItem {
  id: number;
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

export type LlmProvider = "anthropic" | "openai" | "google" | "ollama";

export interface LlmSettings {
  provider: LlmProvider;
  models: Record<"anthropic" | "openai" | "google", string[]>;
  providers: {
    anthropic: { model: string; hasKey: boolean };
    openai: { model: string; hasKey: boolean };
    google: { model: string; hasKey: boolean };
    ollama: { model: string; baseUrl: string };
  };
}

export type ChatEvent =
  | { type: "start"; conversationId: number }
  | { type: "sources"; sources: SourceRef[] }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

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
  getLlmSettings: () => json<LlmSettings>("/api/settings/llm"),
  updateLlmSettings: (update: { provider: LlmProvider; model?: string; apiKey?: string; baseUrl?: string }) =>
    json<LlmSettings>("/api/settings/llm", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    }),
  listConversations: () => json<{ conversations: Conversation[] }>("/api/conversations"),
  getMessages: (id: number) => json<{ messages: Message[] }>(`/api/conversations/${id}/messages`),
  getLatestDigest: () => json<{ date: string; content: string }>("/api/digest/latest"),
  runConsolidation: () => json<{ started: boolean }>("/api/jobs/consolidate", { method: "POST" }),
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
