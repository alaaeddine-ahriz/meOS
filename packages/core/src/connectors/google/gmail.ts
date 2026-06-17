import type {
  ConnectorKindConfig,
  CoverageWindow,
  DeltaResult,
  GmailBackfillState,
  GmailContentMode,
  GmailMessageItem,
} from "../types.js";
import { googleGet, SyncTokenExpiredError } from "./http.js";

/**
 * Thin Gmail REST client. Sync persists metadata + snippet only by default (never
 * the full body) and uses `historyId` as its incremental cursor. A configurable
 * coverage window drives a resumable historical backfill that walks
 * `messages.list` (bounded by `after:`) beyond the recent seed, persisting its
 * pageToken so it survives restarts. The chat tool path additionally fetches
 * thread *text* on demand — that text is returned to the model to cite, not stored.
 */

/** Per-run cap on how many backfill messages we list, so a sync stays bounded. */
const BACKFILL_PAGE_SIZE = 100;
/** How many backfill pages one sync call walks before yielding (resumable). */
const BACKFILL_PAGES_PER_RUN = 3;
/**
 * Max concurrent per-message fetches. Gmail enforces a per-user *concurrent
 * request* cap (separate from the daily quota) and returns 429 "Too many
 * concurrent requests for user." once it's exceeded — a flat `Promise.all` over
 * a 100-message seed plus a 300-message backfill page trips it and aborts the
 * whole sync. A small pool keeps us under the cap while still draining quickly.
 */
const MESSAGE_FETCH_CONCURRENCY = 8;

/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving input
 * order. The bounded sibling of `Promise.all(items.map(fn))` — used so a large
 * message fetch stays under Gmail's per-user concurrency cap.
 */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Days of history a coverage window covers; "all" ⇒ unbounded; "recent" ⇒ seed only. */
function windowDays(window: CoverageWindow): number | null {
  switch (window) {
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "1y":
      return 365;
    case "all":
      return null; // unbounded
    default:
      return 0; // "recent" — no backfill beyond the seed
  }
}

/** The ISO lower bound for a window relative to now, or null when unbounded/seed-only. */
function windowAfterIso(window: CoverageWindow): string | null {
  const days = windowDays(window);
  if (days === null) return null; // "all" — no lower bound
  if (days === 0) return new Date().toISOString(); // "recent" — boundary is now (no backfill)
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

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

function normalize(message: GmailMessage, body?: string): GmailMessageItem {
  const headers = message.payload?.headers;
  const date = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null;
  const item: GmailMessageItem = {
    externalId: message.id,
    threadId: message.threadId,
    subject: header(headers, "Subject").trim() || "(no subject)",
    date,
    from: parseAddress(header(headers, "From")),
    to: parseAddressList(header(headers, "To")),
    snippet: message.snippet?.trim() ?? "",
    deepLink: `https://mail.google.com/mail/u/0/#all/${message.threadId}`,
  };
  if (body && body.trim()) item.body = body.trim().slice(0, 20_000);
  return item;
}

/**
 * Fetch one message and normalize it. In the default "metadata" mode this pulls
 * headers only (never the body); the explicit "rich" opt-in pulls `format=full`
 * and decodes the plain-text body so richer content can be indexed.
 */
async function getMessage(
  accessToken: string,
  id: string,
  mode: GmailContentMode,
): Promise<GmailMessageItem> {
  if (mode === "rich") {
    const message = await googleGet<GmailMessage>(
      `${BASE}/messages/${id}?format=full`,
      accessToken,
    );
    return normalize(message, decodeBody(message.payload));
  }
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

/** A fresh backfill state for a coverage window (null cursor = start at the top). */
function initialBackfill(window: CoverageWindow): GmailBackfillState {
  return {
    pageToken: null,
    afterIso: windowAfterIso(window),
    indexed: 0,
    oldestIndexed: null,
    complete: window === "recent",
  };
}

/** Gmail `after:` takes a unix-seconds (or YYYY/MM/DD) bound; we use epoch seconds. */
function afterQuery(afterIso: string | null): string | undefined {
  if (!afterIso) return undefined;
  return `after:${Math.floor(Date.parse(afterIso) / 1000)}`;
}

/**
 * Advance the resumable historical backfill by up to {@link BACKFILL_PAGES_PER_RUN}
 * pages of `messages.list` (bounded by the window's `after:`), fetching each
 * message at the configured content mode. Persists the pageToken + progress in the
 * returned state so the next run resumes exactly where this one stopped, and flips
 * `complete` once the listing is exhausted. Never blocks: it yields after its page
 * budget even when more remains.
 */
async function runBackfill(
  accessToken: string,
  state: GmailBackfillState,
  mode: GmailContentMode,
): Promise<{ items: GmailMessageItem[]; state: GmailBackfillState; hasMore: boolean }> {
  if (state.complete) return { items: [], state, hasMore: false };
  const ids = new Set<string>();
  let pageToken = state.pageToken ?? undefined;
  let pages = 0;
  let exhausted = false;
  const after = afterQuery(state.afterIso);
  do {
    const params = new URLSearchParams({ maxResults: String(BACKFILL_PAGE_SIZE) });
    if (after) params.set("q", after);
    if (pageToken) params.set("pageToken", pageToken);
    const list = await googleGet<ListResponse>(
      `${BASE}/messages?${params.toString()}`,
      accessToken,
    );
    for (const m of list.messages ?? []) ids.add(m.id);
    pageToken = list.nextPageToken;
    pages++;
    if (!pageToken) {
      exhausted = true;
      break;
    }
  } while (pages < BACKFILL_PAGES_PER_RUN);

  const items = await mapPool([...ids], MESSAGE_FETCH_CONCURRENCY, (id) =>
    getMessage(accessToken, id, mode),
  );
  let oldest = state.oldestIndexed;
  for (const it of items) {
    if (it.date && (!oldest || it.date < oldest)) oldest = it.date;
  }
  const next: GmailBackfillState = {
    pageToken: exhausted ? null : (pageToken ?? null),
    afterIso: state.afterIso,
    indexed: state.indexed + items.length,
    oldestIndexed: oldest,
    complete: exhausted,
  };
  return { items, state: next, hasMore: !exhausted };
}

/**
 * Pull Gmail messages and normalize them. Three jobs in one stateless call:
 *
 *   1. Incremental: with a `syncToken` (a Gmail historyId) walk `history.list`;
 *      with none, seed from the most recent ~100 messages and record the historyId.
 *   2. Cursor-expiry fallback: a too-old historyId (Gmail 404/410) does NOT silently
 *      shrink coverage — it re-seeds from the recent list and keeps the existing
 *      backfill, rather than reporting a destructive full resync.
 *   3. Backfill: advances the resumable historical backfill (bounded by the
 *      coverage window) by a fixed page budget and hands back its cursor + progress.
 *
 * `config` carries the coverage window, content mode, and backfill state; the
 * updated copy is returned via `nextConfig` for the orchestrator to persist.
 */
export async function fetchGmailDelta(
  accessToken: string,
  syncToken?: string | null,
  config?: ConnectorKindConfig,
): Promise<DeltaResult<GmailMessageItem>> {
  const window: CoverageWindow = config?.coverageWindow ?? "recent";
  const mode: GmailContentMode = config?.contentMode ?? "metadata";
  let backfill = config?.backfill ?? initialBackfill(window);
  // A window change resets the backfill boundary so coverage tracks the new choice.
  if (backfill.afterIso !== windowAfterIso(window) && window !== "all") {
    // Only re-seed when the window genuinely changed (not for "all"/unbounded drift).
    const expected = windowAfterIso(window);
    if (backfill.afterIso !== expected && backfill.indexed === 0)
      backfill = initialBackfill(window);
  }

  const ids = new Set<string>();
  let nextSyncToken: string | null = syncToken ?? null;

  try {
    if (!syncToken) {
      const list = await googleGet<ListResponse>(`${BASE}/messages?maxResults=100`, accessToken);
      for (const m of list.messages ?? []) ids.add(m.id);
      const profile = await googleGet<ProfileResponse>(`${BASE}/profile`, accessToken);
      nextSyncToken = profile.historyId ?? null;
    } else {
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
      nextSyncToken = latestHistoryId ?? syncToken;
    }
  } catch (error) {
    // A stale historyId (404/410) must NOT shrink coverage. Re-seed from the recent
    // list and refresh the cursor, preserving the historical backfill in config —
    // rather than reporting a destructive full resync that would clear everything.
    if (error instanceof SyncTokenExpiredError || isHistoryGone(error)) {
      ids.clear();
      const list = await googleGet<ListResponse>(`${BASE}/messages?maxResults=100`, accessToken);
      for (const m of list.messages ?? []) ids.add(m.id);
      const profile = await googleGet<ProfileResponse>(`${BASE}/profile`, accessToken);
      nextSyncToken = profile.historyId ?? null;
    } else {
      throw error;
    }
  }

  const recent = await mapPool([...ids], MESSAGE_FETCH_CONCURRENCY, (id) =>
    getMessage(accessToken, id, mode),
  );

  // Advance the historical backfill (bounded, resumable, non-blocking).
  const bf = await runBackfill(accessToken, backfill, mode);

  const items = recent.concat(bf.items);
  return {
    items,
    deletions: [],
    nextSyncToken,
    nextConfig: { coverageWindow: window, contentMode: mode, backfill: bf.state },
    hasMore: bf.hasMore,
  };
}

/** Gmail returns 404 (not 410) for an expired startHistoryId; detect it from the message. */
function isHistoryGone(error: unknown): boolean {
  return error instanceof Error && /Google API 404 for .*\/history/.test(error.message);
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
