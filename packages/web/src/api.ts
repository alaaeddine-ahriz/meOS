export interface EntitySummary {
  id: number;
  type: string;
  name: string;
  slug: string;
  summary: string | null;
  updatedAt: string;
}

export interface WikiPage {
  entity: EntitySummary & { stale: boolean };
  markdown: string | null;
  relationships: Array<{ label: string; direction: "in" | "out"; other: string }>;
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
}

export type ChatEvent =
  | { type: "start"; conversationId: number }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
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
  ingestText: (title: string, text: string) =>
    json<{ inboxItemId: number }>("/api/ingest/text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title || undefined, text }),
    }),
  uploadFiles: (files: FileList) => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    return json<{ accepted: Array<{ inboxItemId: number; filename: string }> }>("/api/ingest/upload", {
      method: "POST",
      body: form,
    });
  },
  listConversations: () => json<{ conversations: Conversation[] }>("/api/conversations"),
  getMessages: (id: number) => json<{ messages: Message[] }>(`/api/conversations/${id}/messages`),
  getLatestDigest: () => json<{ date: string; content: string }>("/api/digest/latest"),
  runConsolidation: () => json<{ started: boolean }>("/api/jobs/consolidate", { method: "POST" }),
};

export async function* streamChat(message: string, conversationId?: number): AsyncGenerator<ChatEvent> {
  const response = await fetch("/api/chat", {
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
