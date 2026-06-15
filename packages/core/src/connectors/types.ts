/**
 * Provider-agnostic connector layer. Google is the first implementation behind
 * these shapes so other providers (Microsoft, CalDAV, …) can slot in later. All
 * normalized data reaches the graph through the existing merge path — the raw
 * REST clients here only fetch + normalize, the mappers turn an item into an
 * {@link Extraction}, and `sync.ts` orchestrates dedup + ingest.
 */

export type Provider = "google";
export type ConnectorKind = "contacts" | "calendar" | "gmail";

export const CONNECTOR_KINDS: ConnectorKind[] = ["contacts", "calendar", "gmail"];

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
