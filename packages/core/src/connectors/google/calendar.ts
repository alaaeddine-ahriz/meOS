import type { CalendarEventItem, DeltaResult } from "../types.js";
import { googleGet, SyncTokenExpiredError } from "./http.js";

/** Thin Google Calendar REST client: incremental event sync (primary calendar). */

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

/**
 * Pull events changed since `syncToken` (or all upcoming/recent, on first run),
 * expanding recurring events into instances. A cancelled event is reported as a
 * deletion. A stale cursor surfaces as `fullResync`.
 */
export async function fetchCalendarDelta(
  accessToken: string,
  syncToken?: string | null,
): Promise<DeltaResult<CalendarEventItem>> {
  const items: CalendarEventItem[] = [];
  const deletions: string[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  try {
    do {
      const params = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
      if (syncToken) params.set("syncToken", syncToken);
      else
        // First run has no cursor: bound the initial pull to the last ~year so a
        // long calendar history doesn't flood the first sync.
        params.set("timeMin", new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString());
      if (pageToken) params.set("pageToken", pageToken);

      const data = await googleGet<EventsResponse>(
        `${BASE}/calendars/primary/events?${params.toString()}`,
        accessToken,
      );
      for (const event of data.items ?? []) {
        if (event.status === "cancelled") deletions.push(event.id);
        else items.push(normalize(event));
      }
      pageToken = data.nextPageToken;
      nextSyncToken = data.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
  } catch (error) {
    if (error instanceof SyncTokenExpiredError) return { items: [], deletions: [], fullResync: true };
    throw error;
  }

  return { items, deletions, nextSyncToken: nextSyncToken ?? null };
}
