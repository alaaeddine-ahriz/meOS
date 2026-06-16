/**
 * Google behind the connector framework (#5). The first {@link Connector}: it
 * keeps the thin REST clients (people/calendar/gmail) and the deterministic
 * mappers as its normalize step, and exposes the OAuth client as its
 * {@link OAuthProvider}. Adding a second provider means writing a sibling of this
 * file — the orchestrator never learns Google's name.
 */

import type {
  Connector,
  ConnectorManifest,
  NormalizedDelta,
  NormalizedItem,
  OAuthProvider,
  SyncContext,
} from "../framework.js";
import { mapCalendarEvent } from "../map/calendar.js";
import { mapContact } from "../map/contacts.js";
import { mapGmailMessage } from "../map/gmail.js";
import type {
  CalendarEventItem,
  CalendarListEntry,
  ContactItem,
  DeltaResult,
  GmailMessageItem,
  SelfIdentity,
} from "../types.js";
import { fetchCalendarDelta, fetchCalendarList } from "./calendar.js";
import { fetchGmailDelta } from "./gmail.js";
import {
  buildAuthUrl,
  exchangeCode,
  GOOGLE_SCOPES,
  refreshAccessToken,
  revokeToken,
} from "./oauth.js";
import { fetchContactsDelta, fetchSelf } from "./people.js";

/** The Google connector's static description: id, kinds, auth model. */
export const GOOGLE_MANIFEST: ConnectorManifest = {
  id: "google",
  displayName: "Google",
  auth: { kind: "oauth2", scopes: GOOGLE_SCOPES },
  kinds: [
    {
      kind: "contacts",
      displayName: "Contacts",
      sourceType: "google:contacts",
      contentMode: "metadata",
      defaultIntervalMinutes: 60,
    },
    {
      kind: "calendar",
      displayName: "Calendar",
      sourceType: "google:calendar",
      contentMode: "metadata",
      defaultIntervalMinutes: 30,
    },
    {
      kind: "gmail",
      displayName: "Gmail",
      sourceType: "google:gmail",
      contentMode: "metadata",
      defaultIntervalMinutes: 15,
    },
  ],
};

/** Google's OAuth surface, the framework's {@link OAuthProvider} over `oauth.ts`. */
const oauth: OAuthProvider = {
  scopes: GOOGLE_SCOPES,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
};

/**
 * A human-readable rendering of a Google item — the NORMALIZED text that gets
 * chunked, embedded, indexed, and extracted (#19). Kept terse and label-led so
 * the document is searchable by the same phrases a user would type, without
 * leaking the raw API envelope into retrieval.
 */
function renderContact(c: ContactItem): string {
  const lines = [`Contact: ${c.displayName}`];
  if (c.nicknames?.length) lines.push(`Also known as: ${c.nicknames.join(", ")}`);
  if (c.emails?.length) lines.push(`Email: ${c.emails.join(", ")}`);
  if (c.phones?.length) lines.push(`Phone: ${c.phones.join(", ")}`);
  if (c.organisation) lines.push(`Organisation: ${c.organisation}`);
  if (c.jobTitle) lines.push(`Role: ${c.jobTitle}`);
  if (c.birthday) lines.push(`Birthday: ${c.birthday}`);
  return lines.join("\n");
}

function renderEvent(e: CalendarEventItem): string {
  const lines = [`Event: ${e.title}`];
  if (e.start) lines.push(`When: ${e.start}`);
  if (e.organiserEmail) lines.push(`Organiser: ${e.organiserEmail}`);
  if (e.attendees?.length)
    lines.push(`Attendees: ${e.attendees.map((a) => a.name || a.email).join(", ")}`);
  return lines.join("\n");
}

function renderMessage(m: GmailMessageItem): string {
  const lines = [`Email: ${m.subject}`];
  if (m.date) lines.push(`Date: ${m.date}`);
  lines.push(`From: ${m.from.name || m.from.email}`);
  if (m.to?.length) lines.push(`To: ${m.to.map((t) => t.name || t.email).join(", ")}`);
  if (m.snippet) lines.push(`Snippet: ${m.snippet}`);
  // The full body is present only in the explicit "rich" opt-in mode.
  if (m.body) lines.push(`Body: ${m.body}`);
  return lines.join("\n");
}

/** The raw provider payload, stored verbatim so a reprocess needs no re-fetch (#19). */
function rawPayload(item: unknown): string {
  return JSON.stringify(item, null, 2);
}

function toNormalized(
  delta: DeltaResult<unknown>,
  map: (item: unknown) => NormalizedItem,
): NormalizedDelta {
  return {
    items: delta.items.map(map),
    deletions: delta.deletions,
    nextCursor: delta.nextSyncToken ?? null,
    fullResync: delta.fullResync,
    nextConfig: delta.nextConfig,
    hasMore: delta.hasMore,
  };
}

export class GoogleConnector implements Connector {
  readonly manifest = GOOGLE_MANIFEST;
  readonly oauth = oauth;

  /** List the user's Google calendars for the multi-calendar picker (#68). */
  async listCalendars(ctx: SyncContext): Promise<CalendarListEntry[]> {
    return fetchCalendarList(ctx.accessToken);
  }

  async fetchDelta(
    ctx: SyncContext,
    kind: string,
    cursor: string | null,
  ): Promise<NormalizedDelta> {
    const { accessToken, config } = ctx;
    if (kind === "contacts") {
      const delta = await fetchContactsDelta(accessToken, cursor);
      return toNormalized(delta, (raw) => {
        const c = raw as ContactItem;
        return {
          externalId: c.externalId,
          title: c.displayName,
          path: c.deepLink,
          rawContent: rawPayload(c),
          normalizedContent: renderContact(c),
          extraction: mapContact(c),
        };
      });
    }

    // Calendar + Gmail anchor "knows" edges to you, so they need the self identity.
    const self: SelfIdentity = await fetchSelf(accessToken);
    if (kind === "calendar") {
      const delta = await fetchCalendarDelta(accessToken, cursor, config);
      return toNormalized(delta, (raw) => {
        const e = raw as CalendarEventItem;
        return {
          externalId: e.externalId,
          title: e.title,
          path: e.htmlLink,
          rawContent: rawPayload(e),
          normalizedContent: renderEvent(e),
          extraction: mapCalendarEvent(e, self),
        };
      });
    }
    if (kind === "gmail") {
      const delta = await fetchGmailDelta(accessToken, cursor, config);
      return toNormalized(delta, (raw) => {
        const m = raw as GmailMessageItem;
        return {
          externalId: m.externalId,
          title: m.subject,
          path: m.deepLink,
          rawContent: rawPayload(m),
          normalizedContent: renderMessage(m),
          extraction: mapGmailMessage(m, self),
        };
      });
    }
    throw new Error(`Google connector does not support kind: ${kind}`);
  }
}

/** The shared Google connector instance (stateless — safe to reuse). */
export const googleConnector = new GoogleConnector();
