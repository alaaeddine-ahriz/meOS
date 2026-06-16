/**
 * The first-class connector framework (#5).
 *
 * A connector is the product primitive for an external integration: it declares
 * a {@link ConnectorManifest} (who it is, the kinds it syncs, its auth model and
 * per-kind defaults), exposes an {@link OAuthProvider} for the connect flow, and
 * implements a per-kind sync step that pulls a delta and NORMALIZES each changed
 * item into a {@link NormalizedItem}. The orchestrator ({@link syncConnector} in
 * `sync.ts`) drives any connector through this interface, so a second provider
 * slots in by registering a manifest — never by editing the orchestrator.
 *
 * Boundaries this interface captures, mapped to the issue's actions:
 *
 *   manifest        → {@link ConnectorManifest} (id, displayName, kinds)
 *   auth model      → {@link ConnectorManifest.auth} + {@link OAuthProvider}
 *   sync state      → opaque cursor string per kind (the delta token), persisted
 *                     by the store; the connector never touches the DB
 *   delta cursor    → {@link Connector.fetchDelta} takes/returns the cursor and a
 *                     `fullResync` flag when the saved cursor expired
 *   emitted item    → {@link NormalizedItem} — the local item that feeds #19's
 *                     `materialize()` (raw payload + normalized text + extraction)
 *   visibility      → {@link KindManifest.sourceType} → `defaultVisibilityForType`
 *   content modes   → {@link KindManifest.contentMode} ("metadata" | "document")
 *
 * Lifecycle (documented end to end in `connectors/README.md`):
 *   configure → authenticate → initial sync → incremental sync → retry/error →
 *   revoke → delete local data.
 */

import type { Extraction } from "../extract/schema.js";
import type { CalendarListEntry, ConnectorKindConfig, OAuthTokens } from "./types.js";

/**
 * Whether a kind emits lightweight metadata items (contacts, calendar) or richer
 * document-like items (an email body, a Notion page). Surfaced so the UI and the
 * materialization layer can treat the two differently; both flow through the same
 * `materialize()` seam.
 */
export type ContentMode = "metadata" | "document";

/** One syncable data kind a connector supports (e.g. "contacts", "gmail"). */
export interface KindManifest {
  /** Stable kind id, unique within the connector (persisted as the sync-state key). */
  kind: string;
  /** Human-readable label for the settings UI. */
  displayName: string;
  /**
   * The source `type` written to the store for items of this kind, e.g.
   * "google:contacts". Drives the per-kind visibility defaults through
   * `defaultVisibilityForType` (#11) and the source chip.
   */
  sourceType: string;
  /** Lightweight metadata vs richer document-like items. */
  contentMode: ContentMode;
  /** Default poll interval (minutes) when a user first enables this kind. */
  defaultIntervalMinutes: number;
}

/** A connector's auth model. OAuth today; declared so the UI can render the flow. */
export interface AuthManifest {
  kind: "oauth2";
  /** The scopes requested at consent — surfaced for transparency. */
  scopes: readonly string[];
}

/** The static description of a connector: identity, kinds, and auth model. */
export interface ConnectorManifest {
  /** Stable provider id, e.g. "google". Keys the registry and the account row. */
  id: string;
  /** Human-readable provider name for the settings UI. */
  displayName: string;
  /** The data kinds this connector can sync. */
  kinds: readonly KindManifest[];
  /** How the connector authenticates. */
  auth: AuthManifest;
}

/**
 * The OAuth surface a connector exposes for the connect flow. A thin facade over
 * the provider's OAuth client so server routes drive any connector identically.
 */
export interface OAuthProvider {
  /** Scopes requested at consent (mirrors {@link AuthManifest.scopes}). */
  readonly scopes: readonly string[];
  /** Build the consent-screen URL the user opens in a browser. */
  buildAuthUrl(input: {
    clientId: string;
    redirectUri: string;
    challenge: string;
    state: string;
  }): string;
  /** Exchange the authorization code (with its PKCE verifier) for tokens. */
  exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<OAuthTokens>;
  /** Mint a fresh access token from a stored refresh token. */
  refreshAccessToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<OAuthTokens>;
  /** Best-effort token revocation on disconnect. Must not throw. */
  revokeToken(token: string): Promise<void>;
}

/**
 * One changed external item, NORMALIZED by the connector and ready to feed #19's
 * `materialize()`. This is the connector framework's contract with the ingestion
 * pipeline: the connector owns turning a raw provider payload into these fields,
 * and the orchestrator owns persisting + materializing them — neither reaches
 * across that line.
 */
export interface NormalizedItem {
  /** Stable per-item id from the provider (the ledger key for dedup + revisions). */
  externalId: string;
  /** Source title (the person's name, the event/email subject, …). */
  title: string;
  /** Deep link back to the provider item. */
  path: string;
  /** The raw provider payload, kept verbatim so a reprocess needs no re-fetch. */
  rawContent: string;
  /** Human-readable rendering — the text that gets chunked, indexed, extracted. */
  normalizedContent: string;
  /** The deterministic mapping's extraction (the derived semantic stage's input). */
  extraction: Extraction;
}

/**
 * A delta page of NORMALIZED items for one kind. `nextCursor` is persisted as the
 * sync state for the next run; `fullResync` is set when the saved cursor expired
 * and the orchestrator should clear it and re-pull from scratch.
 */
export interface NormalizedDelta {
  items: NormalizedItem[];
  /** External ids removed since the last cursor (soft-deleted locally). */
  deletions: string[];
  /** The cursor to persist for the next run, or null on a full resync seed. */
  nextCursor?: string | null;
  /** Set when the saved cursor was stale; the orchestrator retries from scratch. */
  fullResync?: boolean;
  /**
   * An updated per-kind config blob to persist (e.g. an advanced Gmail backfill
   * cursor, refreshed per-calendar sync tokens). The fetcher computes it; the
   * orchestrator persists it — the connector still never touches the DB.
   */
  nextConfig?: ConnectorKindConfig;
  /**
   * True when more work is immediately available for this kind (e.g. a Gmail
   * backfill page remains). The orchestrator may re-enqueue another sync so a long
   * backfill drains without waiting for the next scheduled tick.
   */
  hasMore?: boolean;
}

/**
 * Per-sync context handed to a connector: the live access token for this account
 * plus the persisted per-kind config (coverage window, backfill cursor, enabled
 * calendars …). The config is read-merge-write: the connector returns an updated
 * blob via {@link NormalizedDelta.nextConfig} and the orchestrator persists it.
 */
export interface SyncContext {
  accessToken: string;
  config?: ConnectorKindConfig;
}

/**
 * The connector contract. Implementations stay stateless: they receive an access
 * token + the saved cursor, talk to their provider, and return NORMALIZED items.
 * They never touch the DB, the schedule, or the materialization seam — the
 * orchestrator owns all of that, which is what lets a new provider drop in
 * without changing `sync.ts` or `connector-manager.ts`.
 */
export interface Connector {
  readonly manifest: ConnectorManifest;
  readonly oauth: OAuthProvider;
  /**
   * Pull a delta for `kind` since `cursor` (null = initial full sync) and
   * normalize each changed item. The orchestrator persists `nextCursor`, skips
   * unchanged items by content hash, and materializes the rest.
   */
  fetchDelta(ctx: SyncContext, kind: string, cursor: string | null): Promise<NormalizedDelta>;
  /**
   * Optional: list the available sub-resources for a kind that the user can pick
   * from (today: Google calendars). Returns undefined for kinds/connectors that
   * have no such selection. Stateless — purely a read against the provider.
   */
  listCalendars?(ctx: SyncContext): Promise<CalendarListEntry[]>;
}

/** Look up a kind's manifest, or undefined if the connector doesn't support it. */
export function kindManifest(connector: Connector, kind: string): KindManifest | undefined {
  return connector.manifest.kinds.find((k) => k.kind === kind);
}
