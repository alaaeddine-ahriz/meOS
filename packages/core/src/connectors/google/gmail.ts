import type { DeltaResult, GmailMessageItem } from "../types.js";
import { googleGet, SyncTokenExpiredError } from "./http.js";

/**
 * Thin Gmail REST client. Sync persists metadata + snippet only (never the full
 * body) and uses `historyId` as its cursor. The chat tool path additionally
 * fetches thread *text* on demand — that text is returned to the model to cite,
 * not stored.
 */

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface Header {
  name: string;
  value: string;
}
interface MessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: MessagePart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: Header[];
    mimeType?: string;
    body?: { data?: string };
    parts?: MessagePart[];
  };
}

function header(headers: Header[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Parse a "Name <email>" address (or a bare email) into its parts. */
function parseAddress(raw: string): { name?: string; email: string } {
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1]?.trim() || undefined, email: match[2]!.trim().toLowerCase() };
  return { email: raw.trim().toLowerCase() };
}

function parseAddressList(raw: string): Array<{ name?: string; email: string }> {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((part) => parseAddress(part))
    .filter((a) => a.email);
}

function normalize(message: GmailMessage): GmailMessageItem {
  const headers = message.payload?.headers;
  const date = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null;
  return {
    externalId: message.id,
    threadId: message.threadId,
    subject: header(headers, "Subject").trim() || "(no subject)",
    date,
    from: parseAddress(header(headers, "From")),
    to: parseAddressList(header(headers, "To")),
    snippet: message.snippet?.trim() ?? "",
    deepLink: `https://mail.google.com/mail/u/0/#all/${message.threadId}`,
  };
}

async function getMessageMetadata(accessToken: string, id: string): Promise<GmailMessageItem> {
  const params = new URLSearchParams({ format: "metadata" });
  for (const h of ["From", "To", "Subject", "Date"]) params.append("metadataHeaders", h);
  const message = await googleGet<GmailMessage>(
    `${BASE}/messages/${id}?${params.toString()}`,
    accessToken,
  );
  return normalize(message);
}

interface ProfileResponse {
  historyId?: string;
  emailAddress?: string;
}
interface ListResponse {
  messages?: Array<{ id: string }>;
  nextPageToken?: string;
}
interface HistoryResponse {
  history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
  historyId?: string;
  nextPageToken?: string;
}

/**
 * Pull messages added since `syncToken` (a Gmail historyId). With no cursor,
 * seed from the most recent ~100 messages and record the current historyId; with
 * one, walk `history.list`. A too-old historyId surfaces as `fullResync`.
 */
export async function fetchGmailDelta(
  accessToken: string,
  syncToken?: string | null,
): Promise<DeltaResult<GmailMessageItem>> {
  const ids = new Set<string>();

  try {
    if (!syncToken) {
      const list = await googleGet<ListResponse>(`${BASE}/messages?maxResults=100`, accessToken);
      for (const m of list.messages ?? []) ids.add(m.id);
      const profile = await googleGet<ProfileResponse>(`${BASE}/profile`, accessToken);
      const items = await Promise.all([...ids].map((id) => getMessageMetadata(accessToken, id)));
      return { items, deletions: [], nextSyncToken: profile.historyId ?? null };
    }

    let pageToken: string | undefined;
    let latestHistoryId: string | undefined;
    do {
      const params = new URLSearchParams({
        startHistoryId: syncToken,
        historyTypes: "messageAdded",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await googleGet<HistoryResponse>(
        `${BASE}/history?${params.toString()}`,
        accessToken,
      );
      for (const h of data.history ?? []) {
        for (const added of h.messagesAdded ?? []) ids.add(added.message.id);
      }
      latestHistoryId = data.historyId ?? latestHistoryId;
      pageToken = data.nextPageToken;
    } while (pageToken);

    const items = await Promise.all([...ids].map((id) => getMessageMetadata(accessToken, id)));
    return { items, deletions: [], nextSyncToken: latestHistoryId ?? syncToken };
  } catch (error) {
    if (error instanceof SyncTokenExpiredError)
      return { items: [], deletions: [], fullResync: true };
    throw error;
  }
}

function decodeBody(part: MessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64").toString("utf-8");
  }
  for (const child of part.parts ?? []) {
    const text = decodeBody(child);
    if (text) return text;
  }
  return "";
}

/**
 * Search threads matching `query` and return their text for the chat agent to
 * cite. On-demand only — nothing here is persisted (consistent with the
 * metadata-only sync). Bounded to a handful of threads to keep the tool result
 * small.
 */
export async function searchThreadsText(
  accessToken: string,
  query: string,
  limit = 5,
): Promise<string> {
  const params = new URLSearchParams({ q: query, maxResults: String(limit) });
  const list = await googleGet<{ threads?: Array<{ id: string }> }>(
    `${BASE}/threads?${params.toString()}`,
    accessToken,
  );
  const threads = list.threads ?? [];
  if (threads.length === 0) return `No email threads matched "${query}".`;

  const blocks = await Promise.all(
    threads.map(async (t) => {
      const thread = await googleGet<{ messages?: GmailMessage[] }>(
        `${BASE}/threads/${t.id}?format=full`,
        accessToken,
      );
      const messages = thread.messages ?? [];
      const subject = header(messages[0]?.payload?.headers, "Subject").trim() || "(no subject)";
      const lines = messages.map((m) => {
        const from = header(m.payload?.headers, "From");
        const date = m.internalDate
          ? new Date(Number(m.internalDate)).toISOString().slice(0, 10)
          : "";
        const body = decodeBody(m.payload).trim() || m.snippet?.trim() || "";
        return `From ${from} (${date}):\n${body.slice(0, 2000)}`;
      });
      return `### Thread: ${subject}\n${lines.join("\n\n")}`;
    }),
  );
  return blocks.join("\n\n---\n\n");
}
