import type {
  CalendarEventItem,
  CalendarListEntry,
  CalendarState,
  ConnectorKindConfig,
  CoverageWindow,
  DeltaResult,
} from "../types.js";
import { googleGet, SyncTokenExpiredError } from "./http.js";

/**
 * Thin Google Calendar REST client: incremental event sync across one or more
 * calendars. Each enabled calendar keeps its OWN sync token (stored per-calendar
 * in the kind config) so they advance independently; recurring events are expanded
 * (`singleEvents`) and cancellations surface as deletions. The initial historical
 * window is configurable (not just the old hard-coded 365 days).
 */

const BASE = "https://www.googleapis.com/calendar/v3";

interface CalendarAttendee {
  email?: string;
  displayName?: string;
  self?: boolean;
  responseStatus?: string;
}
interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: CalendarAttendee[];
}
interface EventsResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}
interface CalendarListResponse {
  items?: Array<{
    id: string;
    summary?: string;
    summaryOverride?: string;
    primary?: boolean;
    accessRole?: string;
    backgroundColor?: string;
  }>;
  nextPageToken?: string;
}

/** Days of history a window covers; null ⇒ unbounded ("all"). */
function windowDays(window: CoverageWindow): number | null {
  switch (window) {
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "1y":
      return 365;
    case "all":
      return null;
    default:
      return 365; // "recent" keeps the legacy ~1-year default
  }
}

function timeMinFor(window: CoverageWindow): string | undefined {
  const days = windowDays(window);
  if (days === null) return undefined; // unbounded
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

function normalize(event: CalendarEvent): CalendarEventItem {
  return {
    externalId: event.id,
    title: event.summary?.trim() || "(untitled event)",
    start: event.start?.dateTime ?? event.start?.date ?? null,
    organiserEmail: event.organizer?.email,
    attendees: (event.attendees ?? [])
      .filter((a) => a.email)
      .map((a) => ({ name: a.displayName?.trim() || undefined, email: a.email!, self: a.self })),
    htmlLink: event.htmlLink || "https://calendar.google.com/",
  };
}

/** List the user's calendars so the UI can offer a multi-calendar picker. */
export async function fetchCalendarList(accessToken: string): Promise<CalendarListEntry[]> {
  const out: CalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: "250" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await googleGet<CalendarListResponse>(
      `${BASE}/users/me/calendarList?${params.toString()}`,
      accessToken,
    );
    for (const c of data.items ?? []) {
      out.push({
        id: c.id,
        summary: c.summaryOverride?.trim() || c.summary?.trim() || c.id,
        primary: Boolean(c.primary),
        accessRole: c.accessRole,
        backgroundColor: c.backgroundColor,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  // Primary first, then alphabetical.
  out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.summary.localeCompare(b.summary));
  return out;
}

/** Pull one calendar's delta, expanding recurring events and surfacing cancellations. */
async function fetchOneCalendar(
  accessToken: string,
  calendarId: string,
  syncToken: string | null,
  window: CoverageWindow,
): Promise<{ items: CalendarEventItem[]; deletions: string[]; nextSyncToken: string | null }> {
  const items: CalendarEventItem[] = [];
  const deletions: string[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  const encoded = encodeURIComponent(calendarId);

  do {
    const params = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
    if (syncToken) params.set("syncToken", syncToken);
    else {
      const timeMin = timeMinFor(window);
      if (timeMin) params.set("timeMin", timeMin);
    }
    if (pageToken) params.set("pageToken", pageToken);

    const data = await googleGet<EventsResponse>(
      `${BASE}/calendars/${encoded}/events?${params.toString()}`,
      accessToken,
    );
    for (const event of data.items ?? []) {
      if (event.status === "cancelled") deletions.push(event.id);
      else items.push(normalize(event));
    }
    pageToken = data.nextPageToken;
    nextSyncToken = data.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  return { items, deletions, nextSyncToken: nextSyncToken ?? syncToken ?? null };
}

/**
 * Pull events changed since the last sync across every enabled calendar. Each
 * calendar carries its own sync token (kept in `config.calendars[id]`); a stale
 * token for a single calendar triggers a bounded re-pull of THAT calendar only,
 * not a global resync. The window bounds an initial pull. Returns the merged
 * items/deletions plus the updated per-calendar config via `nextConfig`.
 *
 * Back-compat: with no enabled calendars, syncs `primary` exactly as before. The
 * `syncToken` parameter (the legacy single-cursor) seeds the primary calendar's
 * per-calendar token on the first multi-calendar run.
 */
export async function fetchCalendarDelta(
  accessToken: string,
  syncToken?: string | null,
  config?: ConnectorKindConfig,
): Promise<DeltaResult<CalendarEventItem>> {
  const window: CoverageWindow = config?.coverageWindow ?? "recent";
  const enabled =
    config?.enabledCalendars && config.enabledCalendars.length > 0
      ? config.enabledCalendars
      : ["primary"];
  const calendars: Record<string, CalendarState> = { ...(config?.calendars ?? {}) };

  const allItems: CalendarEventItem[] = [];
  const allDeletions: string[] = [];

  for (const id of enabled) {
    // Seed primary's per-calendar token from the legacy single cursor on first run.
    let token = calendars[id]?.syncToken ?? null;
    if (token == null && id === "primary" && syncToken) token = syncToken;

    let result: { items: CalendarEventItem[]; deletions: string[]; nextSyncToken: string | null };
    try {
      result = await fetchOneCalendar(accessToken, id, token, window);
    } catch (error) {
      // A stale token for ONE calendar re-pulls just that calendar from the window
      // boundary — coverage for the others is untouched.
      if (error instanceof SyncTokenExpiredError) {
        result = await fetchOneCalendar(accessToken, id, null, window);
      } else {
        throw error;
      }
    }

    allItems.push(...result.items);
    allDeletions.push(...result.deletions);
    const prev = calendars[id];
    calendars[id] = {
      syncToken: result.nextSyncToken,
      lastSyncedAt: new Date().toISOString(),
      indexed: (prev?.indexed ?? 0) + result.items.length,
    };
  }

  return {
    items: allItems,
    deletions: allDeletions,
    // Keep a coarse top-level cursor (primary's token) for legacy callers/tests.
    nextSyncToken: calendars.primary?.syncToken ?? syncToken ?? null,
    nextConfig: { coverageWindow: window, enabledCalendars: enabled, calendars },
  };
}
