/**
 * Provider-agnostic connector layer. Google is the first implementation behind
 * these shapes so other providers (Microsoft, CalDAV, …) can slot in later. All
 * normalized data reaches the graph through the existing merge path — the raw
 * REST clients here only fetch + normalize, the mappers turn an item into an
 * {@link Extraction}, and `sync.ts` orchestrates dedup + ingest.
 */

export type Provider = "google";
export type ConnectorKind = "contacts" | "calendar" | "gmail" | "tasks";

export const CONNECTOR_KINDS: ConnectorKind[] = ["contacts", "calendar", "gmail", "tasks"];

/** OAuth tokens for a connected account. `expiry` is an absolute ISO timestamp. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiry?: string | null;
  scopes?: string | null;
}

/** One contact from Google People, normalized. */
export interface ContactItem {
  /** People API resourceName, e.g. "people/c123". Stable per contact. */
  externalId: string;
  displayName: string;
  nicknames: string[];
  emails: string[];
  phones: string[];
  organisation?: string;
  jobTitle?: string;
  /** ISO date (or MM-DD when the year is unknown). */
  birthday?: string;
  /** Deep link into Google Contacts for this person. */
  deepLink: string;
}

/** A calendar attendee, normalized. `self` marks the account owner. */
export interface EventAttendee {
  name?: string;
  email: string;
  self?: boolean;
}

/** One calendar event from Google Calendar, normalized. */
export interface CalendarEventItem {
  externalId: string;
  title: string;
  /** ISO start (date or date-time). */
  start?: string | null;
  attendees: EventAttendee[];
  organiserEmail?: string;
  /** Deep link into Google Calendar for this event. */
  htmlLink: string;
}

/** One Gmail message, normalized to metadata + snippet (never the full body). */
export interface GmailMessageItem {
  externalId: string;
  threadId: string;
  subject: string;
  /** ISO date the message was sent. */
  date?: string | null;
  from: { name?: string; email: string };
  to: Array<{ name?: string; email: string }>;
  snippet: string;
  /** Deep link into Gmail for this message's thread. */
  deepLink: string;
}

/**
 * One Google Tasks task, normalized. Unlike the other kinds this connector also
 * supports a WRITE path (creating a task) — see `createTask` — making it meOS's
 * first read/write connector kind.
 */
export interface TaskItem {
  /** Stable task id within its list, e.g. "MTIz...". */
  externalId: string;
  title: string;
  /** Free-text notes/body, when set. */
  notes?: string;
  /** ISO due date (Google stores the date portion; time is always 00:00Z). */
  due?: string | null;
  /** Google's status: "needsAction" or "completed". */
  status: "needsAction" | "completed";
  /** True when status === "completed". Convenience for mappers/UI. */
  completed: boolean;
  /** The list this task belongs to. */
  taskListId: string;
  /** Human-readable title of the owning task list. */
  taskListTitle: string;
  /** ISO timestamp of the last modification (drives incremental sync). */
  updated?: string | null;
  /** Deep link into Google Tasks. */
  deepLink: string;
}

/** One Google Tasks task list, used for selection + the create-task default. */
export interface TaskList {
  id: string;
  title: string;
}

/** The account owner's identity, used by mappers to anchor "knows" edges to you. */
export interface SelfIdentity {
  name: string;
  email: string;
}

/**
 * A delta page from a provider. `nextSyncToken` is persisted as the cursor for
 * the next run; `fullResync` is set when the saved cursor expired (Google 410
 * GONE) and the caller should clear it and re-pull from scratch.
 */
export interface DeltaResult<T> {
  items: T[];
  nextSyncToken?: string | null;
  deletions: string[];
  fullResync?: boolean;
}
