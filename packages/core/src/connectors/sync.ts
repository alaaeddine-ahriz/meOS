import crypto from "node:crypto";
import type { Extraction } from "../extract/schema.js";
import type { IngestionPipeline } from "../ingest/pipeline.js";
import type { ConnectorAccountRow, KnowledgeStore } from "../knowledge/store.js";
import { fetchCalendarDelta } from "./google/calendar.js";
import { fetchGmailDelta } from "./google/gmail.js";
import { refreshAccessToken } from "./google/oauth.js";
import { fetchContactsDelta, fetchSelf } from "./google/people.js";
import { mapCalendarEvent } from "./map/calendar.js";
import { mapContact } from "./map/contacts.js";
import { mapGmailMessage } from "./map/gmail.js";
import type {
  CalendarEventItem,
  ConnectorKind,
  ContactItem,
  DeltaResult,
  GmailMessageItem,
  SelfIdentity,
} from "./types.js";

export interface SyncDeps {
  store: KnowledgeStore;
  pipeline: IngestionPipeline;
}

export interface SyncResult {
  ingested: number;
  skipped: number;
  deleted: number;
}

/** Refresh the access token when it's expired (or about to), persisting the new one. */
export async function ensureAccessToken(
  store: KnowledgeStore,
  account: ConnectorAccountRow,
): Promise<string> {
  const expiresSoon = account.expiry ? Date.parse(account.expiry) <= Date.now() + 60_000 : false;
  if (account.access_token && !expiresSoon) return account.access_token;
  if (!account.refresh_token || !account.client_id || !account.client_secret) {
    throw new Error("Google account needs re-authentication (no usable refresh token).");
  }
  const tokens = await refreshAccessToken({
    clientId: account.client_id,
    clientSecret: account.client_secret,
    refreshToken: account.refresh_token,
  });
  store.updateConnectorTokens(account.id, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiry: tokens.expiry,
    scopes: tokens.scopes,
  });
  return tokens.accessToken;
}

const contentHash = (item: unknown): string =>
  crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex");

/** The raw provider payload, stored verbatim so a reprocess needs no re-fetch (#19). */
function rawPayload(item: unknown): string {
  return JSON.stringify(item, null, 2);
}

/**
 * A human-readable rendering of a connector item — the NORMALIZED text that gets
 * chunked, embedded, indexed, and extracted (#19). Kept terse and label-led so
 * the document is searchable by the same phrases a user would type, without
 * leaking the raw API envelope into retrieval.
 */
function normalize(kind: ConnectorKind, item: Record<string, unknown>): string {
  const lines: string[] = [];
  if (kind === "contacts") {
    const c = item as unknown as ContactItem;
    lines.push(`Contact: ${c.displayName}`);
    if (c.nicknames?.length) lines.push(`Also known as: ${c.nicknames.join(", ")}`);
    if (c.emails?.length) lines.push(`Email: ${c.emails.join(", ")}`);
    if (c.phones?.length) lines.push(`Phone: ${c.phones.join(", ")}`);
    if (c.organisation) lines.push(`Organisation: ${c.organisation}`);
    if (c.jobTitle) lines.push(`Role: ${c.jobTitle}`);
    if (c.birthday) lines.push(`Birthday: ${c.birthday}`);
  } else if (kind === "calendar") {
    const e = item as unknown as CalendarEventItem;
    lines.push(`Event: ${e.title}`);
    if (e.start) lines.push(`When: ${e.start}`);
    if (e.organiserEmail) lines.push(`Organiser: ${e.organiserEmail}`);
    if (e.attendees?.length)
      lines.push(`Attendees: ${e.attendees.map((a) => a.name || a.email).join(", ")}`);
  } else {
    const m = item as unknown as GmailMessageItem;
    lines.push(`Email: ${m.subject}`);
    if (m.date) lines.push(`Date: ${m.date}`);
    lines.push(`From: ${m.from.name || m.from.email}`);
    if (m.to?.length) lines.push(`To: ${m.to.map((t) => t.name || t.email).join(", ")}`);
    if (m.snippet) lines.push(`Snippet: ${m.snippet}`);
  }
  return lines.join("\n");
}

/**
 * Sync one kind for one account: refresh the token, pull a delta, and for each
 * changed item map → ingest through the shared merge seam, skipping items whose
 * content hash is unchanged. Persists the next cursor and a status string. A
 * stale cursor triggers one full-resync retry.
 */
export async function syncConnector(
  deps: SyncDeps,
  account: ConnectorAccountRow,
  kind: ConnectorKind,
): Promise<SyncResult> {
  const { store, pipeline } = deps;
  const accessToken = await ensureAccessToken(store, account);
  const state = store.getSyncState(account.id, kind);

  // Self identity anchors "knows" edges for calendar/gmail; contacts don't need it.
  const self: SelfIdentity =
    kind === "contacts" ? { name: "", email: "" } : await fetchSelf(accessToken);

  const run = async (syncToken: string | null) => {
    if (kind === "contacts")
      return fetchContactsDelta(accessToken, syncToken) as Promise<DeltaResult<unknown>>;
    if (kind === "calendar")
      return fetchCalendarDelta(accessToken, syncToken) as Promise<DeltaResult<unknown>>;
    return fetchGmailDelta(accessToken, syncToken) as Promise<DeltaResult<unknown>>;
  };

  let delta = await run(state?.sync_token ?? null);
  if (delta.fullResync) {
    // Saved cursor expired — clear it and re-pull from scratch.
    store.setSyncState(account.id, kind, { syncToken: null });
    delta = await run(null);
  }

  const result: SyncResult = { ingested: 0, skipped: 0, deleted: 0 };
  try {
    // Deletions first: a delta removal marks the item's latest revision inactive
    // (#16) so its facts surface as stale, but never hard-deletes — the audit
    // history and the ledger row (for content-hash dedup if it reappears) stay.
    for (const externalId of delta.deletions) {
      const ledger = store.getConnectorItem(account.id, kind, externalId);
      if (ledger?.source_id != null) {
        store.markSourceGone(ledger.source_id, "deleted");
        for (const id of store.entityIdsWithStaleBackedFacts()) store.markWikiStale(id);
        result.deleted++;
      }
    }

    for (const raw of delta.items) {
      const item = raw as { externalId: string } & Record<string, unknown>;
      const hash = contentHash(item);
      if (store.connectorItemUnchanged(account.id, kind, item.externalId, hash)) {
        result.skipped++;
        continue;
      }

      let extraction: Extraction;
      let title: string;
      let path: string;
      if (kind === "contacts") {
        const c = item as unknown as ContactItem;
        extraction = mapContact(c);
        title = c.displayName;
        path = c.deepLink;
      } else if (kind === "calendar") {
        const e = item as unknown as CalendarEventItem;
        extraction = mapCalendarEvent(e, self);
        title = e.title;
        path = e.htmlLink;
      } else {
        const m = item as unknown as GmailMessageItem;
        extraction = mapGmailMessage(m, self);
        title = m.subject;
        path = m.deepLink;
      }

      // Materialize the item as a local document + revision: searchable even if
      // extraction yields nothing, and re-syncing a changed item advances the
      // SAME logical source's revision (resolved from the ledger) instead of
      // forking a new source row.
      const existing = store.getConnectorItem(account.id, kind, item.externalId);
      const out = await pipeline.materialize({
        type: `google:${kind}`,
        title,
        path,
        rawContent: rawPayload(item),
        normalizedContent: normalize(kind, item),
        extraction,
        existingSourceId: existing?.source_id ?? undefined,
      });
      result.ingested++;
      store.recordConnectorItem(
        account.id,
        kind,
        item.externalId,
        hash,
        out.sourceId,
        out.sourceRevisionId,
      );
    }

    store.setSyncState(account.id, kind, {
      syncToken: delta.nextSyncToken ?? null,
      lastSyncedAt: new Date().toISOString(),
      lastStatus: `ok — ${result.ingested} updated, ${result.skipped} unchanged`,
    });
  } catch (error) {
    store.setSyncState(account.id, kind, {
      lastSyncedAt: new Date().toISOString(),
      lastStatus: `error — ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  }

  return result;
}
