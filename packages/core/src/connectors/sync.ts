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
export async function ensureAccessToken(store: KnowledgeStore, account: ConnectorAccountRow): Promise<string> {
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

/** A small, human-readable provenance blob stored on the connector source. */
function describe(kind: ConnectorKind, item: Record<string, unknown>): string {
  return `${kind} item from Google\n${JSON.stringify(item, null, 2)}`;
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
    if (kind === "contacts") return fetchContactsDelta(accessToken, syncToken) as Promise<DeltaResult<unknown>>;
    if (kind === "calendar") return fetchCalendarDelta(accessToken, syncToken) as Promise<DeltaResult<unknown>>;
    return fetchGmailDelta(accessToken, syncToken) as Promise<DeltaResult<unknown>>;
  };

  let delta = await run(state?.sync_token ?? null);
  if (delta.fullResync) {
    // Saved cursor expired — clear it and re-pull from scratch.
    store.setSyncState(account.id, kind, { syncToken: null });
    delta = await run(null);
  }

  const result: SyncResult = { ingested: 0, skipped: 0, deleted: delta.deletions.length };
  try {
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

      // Skip empty mappings (e.g. an email with no external correspondents), but
      // still record the ledger row so it isn't re-fetched every cycle.
      let sourceId: number | null = null;
      if (extraction.entities.length > 0) {
        const ingest = await pipeline.ingestExtraction({
          type: `google:${kind}`,
          title,
          content: describe(kind, item),
          path,
          extraction,
        });
        sourceId = ingest.sourceId;
        result.ingested++;
      } else {
        result.skipped++;
      }
      store.recordConnectorItem(account.id, kind, item.externalId, hash, sourceId);
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
