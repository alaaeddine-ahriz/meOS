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

import type { ToolSet } from "ai";
import type { Embedder } from "../embedding/embedder.js";
import type { Extraction } from "../extract/schema.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import type { CalendarListEntry, ConnectorKindConfig, OAuthTokens } from "./types.js";

/**
 * Whether a kind emits lightweight metadata items (contacts, calendar) or richer
 * document-like items (an email body, a Notion page). Surfaced so the UI and the
 * materialization layer can treat the two differently; both flow through the same
 * `materialize()` seam.
 */
export type ContentMode = "metadata" | "document";

/**
 * The optional capabilities a kind supports. The settings UI reads THESE flags
 * instead of hardcoding kind names (no more `kind === "gmail"` branches), so a new
 * kind's controls light up purely from its manifest.
 */
export interface KindCapabilities {
  /** Has a "how far back to index" coverage-window control (Gmail, Calendar). */
  coverageWindow?: boolean;
  /** Supports include/exclude label filters (Gmail). */
  labelFilters?: boolean;
  /**
   * Offers a user-selectable set of sub-resources to sync. The string is the
   * picker's resource name (e.g. "calendars", "taskLists") — the connector exposes
   * the list via {@link Connector.listSubResources}.
   */
  subResources?: string;
  /** Read/write: the agent/UI can create items of this kind (Google Tasks). */
  writeable?: boolean;
}

/** Singular/plural nouns for a kind, used by the Sources grouping ("3 contacts"). */
export interface KindNoun {
  one: string;
  many: string;
}

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
  /**
   * Stable brand-logo id for this kind's chip, resolved by the web `LOGO_REGISTRY`
   * (e.g. "gmail", "google-calendar"). Falls back to the connector's `logo`.
   */
  logo?: string;
  /** Singular/plural nouns for the Sources grouping. Falls back to `displayName`. */
  noun?: KindNoun;
  /** One-line description for the settings card (what enabling this kind does). */
  blurb?: string;
  /**
   * Privacy default for items of this kind. `true` (the connector default) keeps
   * derived content off portable artifacts (sync/export) — it stays on-device —
   * see `defaultVisibilityForType`. Set `false` for kinds whose data is freely
   * shareable. Note: private content still feeds the *local* wiki; to keep a kind
   * out of the wiki, mark it {@link directory}.
   */
  private?: boolean;
  /**
   * Whether this kind is a directory/identity source — an address book that only
   * records that entities *exist* (e.g. contacts), as opposed to content that
   * *names* entities in context (events, emails, tasks). Directory items keep an
   * entity searchable but never, by themselves, warrant a wiki page; the entity
   * earns a page once a content source mentions it. Independent of {@link private}.
   */
  directory?: boolean;
  /** Optional capabilities that drive the settings UI without naming the kind. */
  capabilities?: KindCapabilities;
}

/**
 * One credential field a non-OAuth connector collects on connect (an IMAP host,
 * username, password, …). The settings UI renders a form from these declarations,
 * so a basic-auth connector needs no bespoke connect screen.
 */
export interface AuthField {
  /** Stable field id, persisted in the account's auth config blob (e.g. "host"). */
  key: string;
  /** Human-readable label for the form. */
  label: string;
  /** Input type — `password` masks the value in the UI. */
  type: "text" | "password" | "number";
  placeholder?: string;
  /** Whether the field is required for the connection to be considered configured. */
  required?: boolean;
}

/** OAuth2 auth: a hosted consent flow + token refresh (Google, Notion, …). */
export interface OAuthAuthManifest {
  kind: "oauth2";
  /** The scopes requested at consent — surfaced for transparency. */
  scopes: readonly string[];
}

/** Basic auth: the user supplies credentials directly (IMAP host/user/password). */
export interface BasicAuthManifest {
  kind: "basic";
  /** The credential fields the connect form collects. */
  fields: readonly AuthField[];
}

/**
 * A connector's auth model. Declared so the routes + settings UI render and drive
 * the connect flow generically: OAuth2 connectors get a consent URL + callback;
 * basic-auth connectors get a credentials form. New auth kinds extend this union.
 */
export type AuthManifest = OAuthAuthManifest | BasicAuthManifest;

/** The static description of a connector: identity, kinds, and auth model. */
export interface ConnectorManifest {
  /** Stable provider id, e.g. "google". Keys the registry and the account row. */
  id: string;
  /** Human-readable provider name for the settings UI. */
  displayName: string;
  /**
   * Stable brand-logo id resolved by the web `LOGO_REGISTRY` (e.g. "google"). The
   * single irreducible frontend artifact per connector is the matching SVG.
   */
  logo: string;
  /** One-line description for the settings card + the not-connected empty state. */
  summary?: string;
  /** Optional brand accent color (hex), e.g. "#4285F4", for chips/headers. */
  brandColor?: string;
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
  /** Live OAuth access token for an oauth2 connector; "" for basic-auth ones. */
  accessToken: string;
  /**
   * The basic-auth credentials (host/username/password …) for a `auth.kind: "basic"`
   * connector, parsed from the account's stored auth config. Present in place of
   * `accessToken` for those connectors; undefined for OAuth ones.
   */
  authConfig?: Record<string, string>;
  config?: ConnectorKindConfig;
}

/**
 * Context handed to {@link Connector.agentTools} when assembling the chat agent's
 * toolset. The server resolves a live, already-refreshed `accessToken` for the
 * connected account before calling, so a tool's `execute` can hit the provider
 * API directly. The knowledge store + embedder are provided for tools that read
 * locally-synced data (e.g. a calendar-events query over indexed sources).
 */
export interface AgentToolContext {
  store: KnowledgeStore;
  embedder: Embedder;
  /** The kinds the user enabled for this account — gate tools that need a synced kind. */
  enabledKinds: ReadonlySet<string>;
  /**
   * Resolve a live access token for this account, refreshing it if needed. Lazy on
   * purpose: building a tool definition costs no network; the token is minted only
   * when the tool actually runs, so a connected-but-unused connector adds no latency.
   */
  getAccessToken: () => Promise<string>;
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
  /**
   * The OAuth surface — present for `auth.kind === "oauth2"` connectors, omitted
   * for basic-auth ones (which store credentials directly). The routes branch on
   * `manifest.auth.kind`, so this is only read for OAuth connectors.
   */
  readonly oauth?: OAuthProvider;
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
  /**
   * Optional (basic-auth connectors): verify the submitted credentials before the
   * route marks the connector connected — e.g. open + close an IMAP session. Best
   * effort: the route surfaces a failure as a warning rather than hard-failing the
   * save, so a transient outage doesn't block storing valid credentials.
   */
  testConnection?(
    authConfig: Record<string, string>,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Optional: the chat-agent tools this connector contributes when its account is
   * connected. The server merges these into the toolset per turn (see the
   * connector-tools builder), so a connector ships its agent capabilities the same
   * way it ships its sync — no edits to the core tool factory or the chat route.
   */
  agentTools?(ctx: AgentToolContext): ToolSet;
  /**
   * Optional: a short system-prompt fragment describing this connector's tools, so
   * the model knows they exist without the core prompt naming every provider.
   * Appended to the chat system prompt only when the connector is connected.
   */
  readonly promptHint?: string;
}

/** Look up a kind's manifest, or undefined if the connector doesn't support it. */
export function kindManifest(connector: Connector, kind: string): KindManifest | undefined {
  return connector.manifest.kinds.find((k) => k.kind === kind);
}
