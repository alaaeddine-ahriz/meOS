import crypto from "node:crypto";
import type { IngestionPipeline } from "../ingest/pipeline.js";
import type { ConnectorAccountRow, KnowledgeStore } from "../knowledge/store.js";
import type { Connector } from "./framework.js";
import { kindManifest } from "./framework.js";
import { connectorRegistry } from "./registry.js";

export interface SyncDeps {
  store: KnowledgeStore;
  pipeline: IngestionPipeline;
}

export interface SyncResult {
  ingested: number;
  skipped: number;
  deleted: number;
  /** True when more work is immediately available (e.g. a Gmail backfill page). */
  hasMore: boolean;
}

/**
 * Refresh the access token when it's expired (or about to), persisting the new
 * one. Provider-agnostic: it refreshes through the connector's OAuth surface, so
 * any registered connector reuses the same token-lifecycle code.
 */
export async function ensureAccessToken(
  store: KnowledgeStore,
  account: ConnectorAccountRow,
  connector: Connector = connectorRegistry.require(account.provider),
): Promise<string> {
  const expiresSoon = account.expiry ? Date.parse(account.expiry) <= Date.now() + 60_000 : false;
  if (account.access_token && !expiresSoon) return account.access_token;
  if (!connector.oauth) {
    // Only OAuth connectors mint access tokens; a basic-auth connector should never
    // reach this path (it carries its credentials directly into the sync context).
    throw new Error(`${connector.manifest.displayName} is not an OAuth connector.`);
  }
  if (!account.refresh_token || !account.client_id || !account.client_secret) {
    throw new Error(
      `${connector.manifest.displayName} account needs re-authentication (no usable refresh token).`,
    );
  }
  const tokens = await connector.oauth.refreshAccessToken({
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

/** Parse a basic-auth account's stored JSON credentials, or undefined when absent/bad. */
function parseAuthConfig(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return undefined;
  }
}

/**
 * Sync one kind for one account through the connector framework: refresh the
 * token, ask the connector for a NORMALIZED delta, and for each changed item
 * materialize it through the shared `materialize()` seam, skipping items whose
 * content hash is unchanged. Persists the next cursor and a status string. A
 * stale cursor triggers one full-resync retry.
 *
 * The orchestrator is provider-agnostic: it resolves the {@link Connector} from
 * the account's provider via the registry, so a new connector slots in with no
 * change here. Pass `connector` explicitly to override the lookup (tests).
 */
export async function syncConnector(
  deps: SyncDeps,
  account: ConnectorAccountRow,
  kind: string,
  connector: Connector = connectorRegistry.require(account.provider),
): Promise<SyncResult> {
  const { store, pipeline } = deps;
  const manifest = kindManifest(connector, kind);
  if (!manifest) {
    throw new Error(`${connector.manifest.displayName} does not support kind: ${kind}`);
  }
  // The auth model decides what the connector carries into its fetch: an OAuth
  // connector gets a live access token; a basic-auth one gets its stored
  // credentials (host/username/password …) with an empty token. Everything after
  // this — dedup, materialize, cursor persistence — is identical for both.
  let accessToken = "";
  let authConfig: Record<string, string> | undefined;
  if (connector.manifest.auth.kind === "basic") {
    authConfig = parseAuthConfig(account.auth_config);
    if (!authConfig) {
      throw new Error(`${connector.manifest.displayName} account has no stored credentials.`);
    }
  } else {
    accessToken = await ensureAccessToken(store, account, connector);
  }
  const state = store.getSyncState(account.id, kind);
  const config = store.getSyncConfig(account.id, kind);
  const ctx = { accessToken, authConfig, config };

  const result: SyncResult = {
    ingested: 0,
    skipped: 0,
    deleted: 0,
    hasMore: false,
  };
  try {
    // Fetch inside the try so a delta failure (e.g. a provider 429) is recorded as
    // an `error` status the UI can surface, rather than bubbling out unrecorded and
    // leaving the kind looking enabled-but-never-synced.
    let delta = await connector.fetchDelta(ctx, kind, state?.sync_token ?? null);
    if (delta.fullResync) {
      // Saved cursor expired — clear it and re-pull from scratch (config preserved).
      store.setSyncState(account.id, kind, { syncToken: null });
      delta = await connector.fetchDelta(ctx, kind, null);
    }
    result.hasMore = Boolean(delta.hasMore);

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

    for (const item of delta.items) {
      const hash = contentHash(item);
      if (store.connectorItemUnchanged(account.id, kind, item.externalId, hash)) {
        result.skipped++;
        continue;
      }

      // Materialize the normalized item as a local document + revision: searchable
      // even if extraction yields nothing, and re-syncing a changed item advances
      // the SAME logical source's revision (resolved from the ledger) instead of
      // forking a new source row. `materialize()` applies the per-type visibility
      // defaults from the kind's `sourceType` (#11).
      const existing = store.getConnectorItem(account.id, kind, item.externalId);
      const out = await pipeline.materialize({
        type: manifest.sourceType,
        title: item.title,
        path: item.path,
        rawContent: item.rawContent,
        normalizedContent: item.normalizedContent,
        extraction: item.extraction,
        existingSourceId: existing?.source_id ?? undefined,
        // The kind's "one of two" choice. Default "index" keeps connector syncs
        // from spinning up wiki runs; "wiki" authors pages proactively.
        skipWikiRefresh: (config?.mode ?? "index") === "index",
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

    // A backfill that still has pages to walk reads as in-progress, so the UI can
    // show coverage isn't yet complete even on an otherwise-clean run.
    const progress = delta.hasMore ? " (backfilling…)" : "";
    const at = new Date().toISOString();
    // Persist structured counts alongside the free-text status (#88), so the
    // coverage UI + health dashboard read machine-readable metrics rather than
    // parsing a string. `okAt` records this success as the last-successful time.
    // Merged into nextConfig so a single config write carries both.
    const lastSync = {
      at,
      ok: true,
      indexed: result.ingested,
      skipped: result.skipped,
      deleted: result.deleted,
      okAt: at,
      error: null,
      // Preserve the prior failure timestamp; a success doesn't erase the history.
      errorAt: config?.lastSync?.errorAt ?? null,
    };
    store.setSyncState(account.id, kind, {
      syncToken: delta.nextCursor ?? null,
      config: { ...(delta.nextConfig ?? {}), lastSync },
      lastSyncedAt: at,
      lastStatus: `ok — ${result.ingested} updated, ${result.skipped} unchanged${progress}`,
    });
  } catch (error) {
    const at = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    // Record the failure as structured metrics too, but PRESERVE the last
    // successful sync timestamp (`okAt`) so the UI can show "last success" vs
    // "last failure" independently (#88). Re-read config in case the try block
    // mutated it before throwing.
    const prior = store.getSyncConfig(account.id, kind).lastSync;
    store.setSyncState(account.id, kind, {
      lastSyncedAt: at,
      lastStatus: `error — ${message}`,
      config: {
        lastSync: {
          at,
          ok: false,
          indexed: result.ingested,
          skipped: result.skipped,
          deleted: result.deleted,
          okAt: prior?.okAt ?? null,
          error: message,
          errorAt: at,
        },
      },
    });
    throw error;
  }

  return result;
}
