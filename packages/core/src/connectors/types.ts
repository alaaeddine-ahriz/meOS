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
  /**
   * The decoded plain-text body, present ONLY in the explicit "rich" content mode
   * (opt-in); undefined in the default metadata-only mode so bodies are never
   * indexed without the user choosing to.
   */
  body?: string;
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
 *
 * `nextConfig` lets a fetcher hand back an updated per-kind config blob (e.g. an
 * advanced Gmail backfill cursor, or refreshed per-calendar sync tokens) for the
 * orchestrator to persist — keeping the fetcher itself stateless w.r.t. the DB.
 */
export interface DeltaResult<T> {
  items: T[];
  nextSyncToken?: string | null;
  deletions: string[];
  fullResync?: boolean;
  nextConfig?: ConnectorKindConfig;
  /** True when more work remains immediately (e.g. a backfill page is pending). */
  hasMore?: boolean;
}

/** How far back a kind indexes. "recent" = the safe ~100-message / 1-year seed. */
export type CoverageWindow = "recent" | "30d" | "90d" | "1y" | "all";

/** Whether Gmail indexes metadata only (default, private) or richer content (opt-in). */
export type GmailContentMode = "metadata" | "rich";

/**
 * The user-facing completeness state of a kind's sync (#88). Derived from the
 * coverage window, backfill progress, and the last sync outcome so the UI never
 * shows an ambiguous "connected"-only state:
 *  - "complete": the chosen window is fully indexed (window "all" with a finished
 *    backfill, or a window with no pending backfill).
 *  - "backfilling": a historical backfill is still walking the window.
 *  - "recent-only": only the recent seed is indexed (window narrower than chosen,
 *    or no backfill has run yet for a non-"recent" window).
 *  - "partial": indexed but coverage is known-incomplete (e.g. some lists/calendars
 *    excluded) — a softer signal than recent-only.
 *  - "failed": the last sync attempt errored.
 *  - "idle": never synced yet.
 */
export type CoverageState =
  | "complete"
  | "partial"
  | "recent-only"
  | "failed"
  | "backfilling"
  | "idle";

/**
 * Structured metrics from the most recent sync run (#88), persisted in the
 * {@link ConnectorKindConfig} JSON blob so no migration is needed. The free-text
 * `last_status` string is kept alongside for back-compat; this is the machine-
 * readable counterpart the health dashboard + coverage UI read.
 *
 * Three timestamps are tracked separately so the UI can show "last attempt" vs
 * "last success" vs "last failure": `at` is the last ATTEMPT; `okAt` the last
 * SUCCESS; `errorAt` the last FAILURE. A failed run preserves the prior `okAt`.
 */
export interface ConnectorSyncMetrics {
  /** ISO timestamp of the last sync attempt (success or failure). */
  at: string;
  /** Whether that last attempt succeeded. */
  ok: boolean;
  /** Items materialized/updated on the last successful run. */
  indexed: number;
  /** Items seen but unchanged (skipped) on the last successful run. */
  skipped: number;
  /** Items soft-deleted on the last successful run. */
  deleted: number;
  /** Items that failed on the last run (reserved; 0 today). */
  failed?: number;
  /** ISO timestamp of the last SUCCESSFUL sync (preserved across later failures). */
  okAt?: string | null;
  /** The last error message, when the most recent attempt failed. */
  error?: string | null;
  /** ISO timestamp of the last FAILURE. */
  errorAt?: string | null;
}

/**
 * The "enable one of two" choice for a kind: "index" indexes items locally as
 * linked entities/sources (browsable in the Sources tab, read by the wiki-
 * maintainer as source material) without authoring wiki pages on sync; "wiki"
 * additionally drives wiki regeneration so the facts are woven into prose.
 */
export type IndexMode = "index" | "wiki";

/**
 * The resumable historical-backfill cursor for Gmail. Persisted between runs so a
 * long mailbox pull survives restarts and never blocks the app. `complete` flips
 * true once the backfill has walked past the window boundary.
 */
export interface GmailBackfillState {
  /** messages.list pageToken to resume from, or null at the start / when done. */
  pageToken: string | null;
  /** ISO lower bound (window boundary) the backfill is filling down to. */
  afterIso: string | null;
  /** Items indexed by the backfill so far (cumulative across runs). */
  indexed: number;
  /** Oldest message internalDate (ISO) the backfill has reached, if any. */
  oldestIndexed: string | null;
  /** True once the backfill has exhausted the window. */
  complete: boolean;
}

/** Per-calendar incremental state, keyed by calendar id in the calendar config. */
export interface CalendarState {
  /** Google sync token for this calendar's incremental delta. */
  syncToken: string | null;
  lastSyncedAt: string | null;
  /** Events indexed for this calendar (cumulative). */
  indexed: number;
}

/**
 * The per-kind config blob persisted in `connector_sync_state.config` (JSON). All
 * fields optional so legacy `{}` rows behave like the prior defaults. Gmail and
 * Calendar use disjoint subsets.
 */
export interface ConnectorKindConfig {
  /**
   * Index-only vs index+wiki for this kind (the "one of two" enable choice).
   * Undefined is treated as "index" — the safe, lighter default.
   */
  mode?: IndexMode;

  /**
   * Structured metrics from the last sync run (#88). Persisted here (in the JSON
   * blob) rather than as new columns so no migration is needed; the free-text
   * `last_status` string still mirrors it for legacy clients.
   */
  lastSync?: ConnectorSyncMetrics;

  // --- gmail ---
  /** How far back Gmail backfills. Default "recent". */
  coverageWindow?: CoverageWindow;
  /** Metadata-only (default, private) vs richer content (explicit opt-in). */
  contentMode?: GmailContentMode;
  /** Resumable historical backfill cursor + progress. */
  backfill?: GmailBackfillState;
  /**
   * Gmail label ids/names to INCLUDE — when set, only messages carrying one of
   * these labels are indexed (#88). Empty/undefined ⇒ no include filter.
   */
  includeLabels?: string[];
  /**
   * Gmail label ids/names to EXCLUDE — messages carrying any of these are skipped
   * (#88). Applied after the include filter. Empty/undefined ⇒ no exclude filter.
   */
  excludeLabels?: string[];

  // --- calendar ---
  /** Calendar ids the user enabled for sync. Empty/undefined ⇒ primary only. */
  enabledCalendars?: string[];
  /** Per-calendar incremental state, keyed by calendar id. */
  calendars?: Record<string, CalendarState>;

  // --- tasks ---
  /** Task-list ids the user enabled for sync (#88). Empty/undefined ⇒ all lists. */
  enabledTaskLists?: string[];
}

/**
 * Derive the user-facing {@link CoverageState} for a kind (#88) from its persisted
 * config + last-sync metrics. Pure + deterministic so the route and tests share
 * one definition. Order of precedence: a recent failure dominates; an in-progress
 * backfill reads as "backfilling"; an unfinished/un-run backfill on a non-"recent"
 * window reads as "recent-only"; an explicit exclusion reads as "partial";
 * otherwise "complete" (or "idle" before the first sync).
 */
export function deriveCoverageState(config: ConnectorKindConfig): CoverageState {
  const last = config.lastSync;
  // A failed most-recent attempt dominates — the user needs to fix it first.
  if (last && last.ok === false) return "failed";
  // Never synced (no metrics, no free-text either): idle.
  if (!last) return "idle";

  const window = config.coverageWindow ?? "recent";

  // Gmail: the backfill cursor tells us whether the historical window is filled.
  if (config.backfill) {
    if (!config.backfill.complete) return "backfilling";
    // Backfill finished. If labels are being excluded, coverage is intentionally partial.
    if ((config.excludeLabels?.length ?? 0) > 0 || (config.includeLabels?.length ?? 0) > 0) {
      return "partial";
    }
    return "complete";
  }

  // No backfill state recorded yet. A non-"recent" window that hasn't backfilled
  // reads as recent-only (only the seed is indexed); "recent" itself is complete.
  if (window !== "recent") return "recent-only";

  // Tasks with a subset of lists, or any kind with no further detail: complete
  // unless an explicit subset narrows it.
  if ((config.enabledTaskLists?.length ?? 0) > 0) return "partial";

  return "complete";
}

/** One calendar from the user's Google calendar list, for the picker UI. */
export interface CalendarListEntry {
  id: string;
  summary: string;
  primary: boolean;
  /** The user's access role, e.g. "owner" | "reader". */
  accessRole?: string;
  backgroundColor?: string;
}
