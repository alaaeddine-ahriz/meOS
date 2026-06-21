import { createHash } from "node:crypto";
import type { CalendarEventItem, ConnectorKindConfig } from "../connectors/types.js";
import type { MeosDatabase } from "../db/database.js";
import { deserializeVector, serializeVector } from "../embedding/vectors.js";
import type { EntityType, Extraction } from "../extract/schema.js";
import { CONFIDENCE_CAP, REINFORCE_STEP } from "../memory/confidence.js";
import { OBSERVATION_KINDS } from "./schema-doc.js";
import {
  enabledEntityTypes,
  enabledObservationKinds,
  ENTITY_TYPES,
  type KnowledgePreferences,
  resolvePreferences,
} from "./preferences.js";
import { defaultVisibilityForType, type SourceVisibility } from "./visibility.js";

/** Parse JSON we wrote ourselves, tolerating a corrupt row by returning undefined
 * (a single bad blob shouldn't break loading the whole conversation/list). */
function safeParseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Settings-table key for the user's knowledge preferences (#86). */
const KNOWLEDGE_PREFERENCES_KEY = "knowledge_preferences";
const ENTITY_TYPE_COUNT = ENTITY_TYPES.length;
const OBSERVATION_KIND_COUNT = OBSERVATION_KINDS.length;
const ENABLED_ENTITY_TYPES = (prefs: KnowledgePreferences): EntityType[] => [
  ...enabledEntityTypes(prefs),
];

export interface EntityRow {
  id: number;
  type: EntityType;
  name: string;
  slug: string;
  summary: string | null;
  wiki_stale: number;
  created_at: string;
  updated_at: string;
}

/** A node in a traversed subgraph — the fields a graph view needs to draw + link it. */
export interface SubgraphNode {
  id: number;
  type: string;
  name: string;
  slug: string;
}

/** A labelled, directed edge between two subgraph nodes. */
export interface SubgraphEdge {
  from: number;
  to: number;
  label: string;
}

/** A connected slice of the knowledge graph: nodes reached and the edges among them. */
export interface Subgraph {
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
}

function toSubgraphNode(entity: EntityRow): SubgraphNode {
  return { id: entity.id, type: entity.type, name: entity.name, slug: entity.slug };
}

export interface ObservationRow {
  id: number;
  entity_id: number;
  text: string;
  source_id: number | null;
  tier: "observation" | "fact";
  confidence: number;
  status: "active" | "superseded" | "contradicted";
  superseded_by: number | null;
  kind: string;
  source_quote: string | null;
  char_start: number | null;
  char_end: number | null;
  valid_from: string | null;
  valid_until: string | null;
  sensitivity: "normal" | "private" | "secret";
  memory_tier: "working" | "episodic" | "semantic" | "procedural";
  created_at: string;
  last_confirmed_at: string;
}

export interface RelationshipView {
  id: number;
  label: string;
  from_entity: number;
  to_entity: number;
  from_name: string;
  to_name: string;
  confidence: number;
  status: "active" | "superseded" | "contradicted";
}

export interface InboxItemRow {
  id: number;
  source_id: number | null;
  title: string;
  status: string;
  detail: string | null;
  /** Absolute path for watched files; null for uploads and pasted text. */
  path: string | null;
  /** How many times this file has been ingested; > 1 means it changed and was re-read. */
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ChunkWithVector {
  id: number;
  source_id: number;
  source_title: string;
  source_path: string | null;
  text: string;
  vector: Float32Array;
  /** Structure-aware metadata (#14); null on chunks written before migration 19. */
  section_title: string | null;
  page_start: number | null;
  page_end: number | null;
  char_start: number | null;
  char_end: number | null;
}

/** A chunk row to persist. Metadata fields (#14) are optional for back-compat. */
export interface ChunkInput {
  text: string;
  embedding: Float32Array;
  sourceBlockIds?: string[];
  sectionTitle?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  charStart?: number | null;
  charEnd?: number | null;
  tokenEstimate?: number | null;
  contentType?: string | null;
}

/** A chunk's persisted structure metadata, for citation + chunk↔source navigation. */
export interface ChunkMetadataRow {
  id: number;
  source_id: number;
  seq: number;
  source_block_ids: string | null;
  section_title: string | null;
  page_start: number | null;
  page_end: number | null;
  char_start: number | null;
  char_end: number | null;
  token_estimate: number | null;
  content_type: string | null;
  /** Placeholder for #16 (source revisions); always null until then. */
  source_revision_id: number | null;
}

/** The lifecycle of a single source revision (one ingested version of a source). */
export type SourceRevisionStatus =
  | "active"
  | "missing"
  | "deleted"
  | "superseded"
  | "failed"
  | "incomplete";

/** One ordered content version of a logical source (#16). */
export interface SourceRevisionRow {
  id: number;
  source_id: number;
  revision: number;
  status: SourceRevisionStatus;
  content_hash: string | null;
  raw_content: string | null;
  normalized_content: string | null;
  created_at: string;
}

/** The structured fields of a meeting note, stored alongside its source (#26). */
export interface MeetingNoteRow {
  source_id: number;
  /** ISO date (YYYY-MM-DD) the meeting took place, or null if unknown. */
  meeting_date: string | null;
  /** The attendee names. */
  attendees: string[];
  /** Classifier confidence in [0,1] for an auto-detected meeting; null for manual (#85). */
  detection_confidence: number | null;
  /** How the note became a meeting: 'auto' (detected at ingest) or 'manual' (#85). */
  detection_method: "auto" | "manual";
  /** A matched google:calendar event source, when one was linked; null otherwise (#85). */
  linked_calendar_source_id: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * A synced calendar event surfaced for `@`-mention autocomplete. Derived from the
 * materialized `google:calendar` sources (their `raw_content` is the normalized
 * {@link CalendarEventItem}), so it needs no extra storage.
 */
export interface CalendarEventRef {
  sourceId: number;
  externalId: string | null;
  title: string;
  /** ISO start (date or date-time), or null when unknown. */
  start: string | null;
  attendees: string[];
  htmlLink: string;
}

/** Review status of an auto-suggested meeting → entity link (#26). */
export type MeetingLinkStatus = "suggested" | "accepted" | "rejected";

/** How a meeting → entity link was resolved (drives the "why linked" rationale). */
export type MeetingLinkMethod = "name" | "alias" | "slug";

/** One persisted, reviewable meeting → entity link suggestion (#26). */
export interface MeetingLinkSuggestionRow {
  id: number;
  source_id: number;
  entity_id: number;
  /** Human-readable "why linked" explanation. */
  rationale: string;
  method: MeetingLinkMethod;
  status: MeetingLinkStatus;
  created_at: string;
  /** Joined entity fields, for the review UI. */
  entity_name: string;
  entity_type: EntityType;
  entity_slug: string;
}

/** Which extraction strategy produced a cached partial (#15). */
export type ExtractionStrategy = "single" | "map-reduce";

/**
 * The version tuple that, together with a revision + section content hash,
 * keys an extraction-cache row (#15). A change to any component invalidates the
 * cache for that section so a stale partial is never served.
 */
export interface ExtractionCacheKey {
  sourceRevisionId: number;
  /** sha256 of the exact section text the LLM saw (context included). */
  contentHash: string;
  schemaVersion: string;
  promptVersion: string;
  modelId: string;
  profileVersion: string;
}

/** A cached partial extraction (#15). */
export interface ExtractionCacheRow {
  id: number;
  source_revision_id: number;
  content_hash: string;
  schema_version: string;
  prompt_version: string;
  model_id: string;
  profile_version: string;
  strategy: ExtractionStrategy;
  /** The partial Extraction, JSON-encoded. */
  extraction: string;
  token_usage: number;
  created_at: string;
}

/**
 * A fact (observation) whose only remaining support is a revision that is no
 * longer current — superseded by a newer version, or from a deleted/missing
 * source. Surfaced to the UI so obsolete claims are visible as such.
 */
export interface StaleBackedObservationRow {
  id: number;
  entity_id: number;
  entity_name: string;
  entity_slug: string;
  text: string;
  /** The worst (most obsolete) status among the revisions backing this claim. */
  revision_status: SourceRevisionStatus;
}

/** Which dedicated queue an ingest job rides (#13). */
export type IngestQueueKind = "extraction" | "embedding";

/** The durable lifecycle state of an ingest job (#13). */
export type IngestJobState = "pending" | "processing" | "completed" | "failed" | "dead-letter";

/**
 * The automatic "provider hold" on ingest: set when the intelligence provider
 * itself is unusable (no credits, rejected key, unknown model) so the executor
 * stops the whole batch with one actionable reason instead of failing every file
 * the same way. `kind` is the {@link LlmErrorKind}; `since` is an ISO timestamp.
 */
export interface IngestHold {
  reason: string;
  kind: string;
  since: string;
}

/**
 * Work-type priority classes for the durable extraction queue (#18). Mirrors the
 * in-memory {@link JobQueue}'s ladder so the two scheduling paths agree: a
 * user-uploaded note outranks a watched file, which outranks a connector sync,
 * which outranks nightly maintenance. `claimIngestJob` orders by
 * (priority DESC, id ASC), so within a class the queue stays strictly FIFO.
 */
export const IngestPriority = {
  USER: 40,
  WATCH: 30,
  CONNECTOR: 20,
  NIGHTLY: 10,
} as const;

/** One durable ingestion unit — a file/upload/paste tracked across crashes (#13). */
export interface IngestJobRow {
  id: number;
  kind: string;
  queue: IngestQueueKind;
  stage: string;
  state: IngestJobState;
  /** Work-type priority class (#18): higher drains first. See {@link IngestPriority}. */
  priority: number;
  attempts: number;
  max_attempts: number;
  payload: string | null;
  inbox_item_id: number | null;
  source_id: number | null;
  source_revision_id: number | null;
  content_hash: string | null;
  byte_size: number | null;
  last_error: string | null;
  leased_at: string | null;
  run_after: string;
  created_at: string;
  updated_at: string;
}

/** One attempt's audit/debug record for an ingest job (#13, read by #18). */
export interface IngestRunRow {
  id: number;
  job_id: number;
  attempt: number;
  stage: string;
  state: "processing" | "completed" | "failed" | "dead-letter";
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** Aggregate per-queue health for the runtime surface (#13). */
export interface IngestQueueDepth {
  queue: IngestQueueKind;
  pending: number;
  processing: number;
  failed: number;
  deadLetter: number;
}

/**
 * Extended per-queue metrics for the observability surface (#18): the #13 depth
 * counters plus the diagnostics the issue calls for — how many jobs are mid-
 * retry, completed, the average completed-run duration, and the age of the
 * oldest still-queued job. Aggregated from `ingest_jobs` + `ingest_runs`.
 */
export interface IngestQueueMetrics extends IngestQueueDepth {
  /** Jobs that have failed at least once but are still under their retry budget. */
  retrying: number;
  /** Jobs that finished successfully (and survive retention). */
  completed: number;
  /** Mean wall-clock seconds of completed runs on this queue (0 if none). */
  avgDurationSeconds: number;
  /** ISO timestamp of the oldest job still `pending`, or null if the queue is drained. */
  oldestQueuedAt: string | null;
}

/**
 * Per-stage timing + outcome counts aggregated from `ingest_runs` (#18). One row
 * per distinct stage (e.g. `indexing`, `extraction`, `merge`), summarising how
 * many attempts of that stage succeeded vs failed and how long they took — the
 * "where is ingestion slow / failing?" view.
 */
export interface IngestStageMetric {
  stage: string;
  /** Runs of this stage that completed successfully. */
  completed: number;
  /** Runs that failed (retryable failure). */
  failed: number;
  /** Runs that exhausted retries on this stage. */
  deadLetter: number;
  /** Runs still in flight (open `processing` row). */
  processing: number;
  /** Mean wall-clock seconds across this stage's finished runs (0 if none). */
  avgDurationSeconds: number;
  /** Total wall-clock seconds across this stage's finished runs. */
  totalDurationSeconds: number;
}

/**
 * Stale-job recovery counters (#18): how many jobs the durable layer has
 * reclaimed from a crashed `processing` state, and how many ultimately
 * dead-lettered. Derived from `ingest_runs` (recovery closes a run with a
 * recognizable error) + `ingest_jobs`.
 */
export interface IngestRecoveryMetrics {
  /** Runs closed by stale-`processing` recovery (worker crashed mid-run). */
  recovered: number;
  /** Jobs currently parked in dead-letter (retries exhausted). */
  deadLettered: number;
}

/**
 * A background worker's health as written by the process that runs it (#94). When
 * workers run in a forked worker process the app process can't read their
 * in-memory state, so the worker upserts this snapshot on a heartbeat and the
 * app reads it back via {@link KnowledgeStore.listWorkerHealth}. `queue` is the
 * optional durable-queue depth blob (serialized to `queue_json`); the staleness
 * of `heartbeatAt` tells the reader whether the worker is still alive.
 */
export interface WorkerHealthSnapshot {
  name: string;
  status: string;
  detail?: string | null;
  lastError?: string | null;
  lastRunAt?: string | null;
  /** Arbitrary JSON-serializable extra (the ingest queues' QueueDepth). */
  queue?: unknown;
}

/** A persisted {@link WorkerHealthSnapshot} plus the heartbeat timestamp. */
export interface WorkerHealthRecord extends WorkerHealthSnapshot {
  /** ISO timestamp of the last heartbeat; used to detect a dead worker. */
  heartbeatAt: string;
}

/**
 * Per-extraction cost telemetry (#15/#18): the model, prompt version, strategy,
 * token usage, and best-effort estimated cost of cached extractions, grouped by
 * (model, prompt version, strategy). Token usage is currently plumbed-but-zero
 * upstream; the shape surfaces it so it lights up the moment it is populated.
 */
export interface IngestCostMetric {
  modelId: string;
  promptVersion: string;
  strategy: ExtractionStrategy;
  /** How many cached extraction partials this group covers. */
  extractions: number;
  /** Total tokens recorded across the group (0 until token_usage is populated). */
  tokenUsage: number;
  /** Best-effort estimated USD cost, or null when no rate is known for the model. */
  estimatedCostUsd: number | null;
}

export interface SourceRef {
  id: number;
  title: string;
  path: string | null;
  /**
   * The source's origin (file/image/conversation/session, or a connector kind
   * like "google:contacts"). Optional so existing call sites stay valid; the web
   * source list uses it to render provider-aware, deep-linkable chips.
   */
  type?: string;
  /**
   * Structure-aware citation locators (#14): the page/section/char-span of the
   * cited excerpt within the source. Set by retrieval from the backing chunk's
   * metadata; all optional, so a citation that has only a document still works.
   */
  section?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  charStart?: number | null;
  charEnd?: number | null;
}

/**
 * One step of a persisted coding-agent trace — the reload-safe form of the live
 * reasoning / tool-call / answer-text stream. Structurally identical to the
 * contracts `AgentTracePart` (core can't import contracts); the server bridges
 * the two. `state`/`toolCallId` are live-only and intentionally dropped here.
 */
export type AgentTracePart =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; toolName: string; input: unknown; output?: unknown; isError?: boolean };

/** A coding-agent turn's run metadata, persisted via {@link Store.saveMessageAgentMeta}. */
export interface MessageAgentMeta {
  /** The IDE-style timeline (reasoning + tools + answer text), in arrival order. */
  trace?: AgentTracePart[];
  /** The run's cost/turns/duration (all 0 for CLIs that don't report — then omitted). */
  telemetry?: { costUsd: number; numTurns: number; durationMs: number };
  /** Files the run created/edited/removed in its workspace. */
  filesChanged?: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
}

/** A wiki/graph entity an indexed connector item links to (the Sources tab). */
export interface IndexedEntityLinkRow {
  id: number;
  type: string;
  name: string;
  slug: string;
  /** True when the entity warrants a wiki page (so the UI links to one). */
  hasPage: boolean;
}

/** One locally-indexed connector item, for the Sources tab listing. */
export interface IndexedSourceRow {
  id: number;
  provider: string;
  kind: string;
  type: string;
  title: string;
  link: string | null;
  createdAt: string | null;
  status: string | null;
  linkedEntities: IndexedEntityLinkRow[];
}

/** Another indexed item connected to one through a shared entity. */
export interface RelatedSourceRow {
  id: number;
  provider: string;
  kind: string;
  type: string;
  title: string;
  link: string | null;
  /** Entity name(s) that connect the two items. */
  via: string[];
}

/** An indexed item with its content + the items/entities it links to. */
export interface IndexedSourceDetailRow extends IndexedSourceRow {
  content: string | null;
  relatedSources: RelatedSourceRow[];
}

/** An indexed connector item with its content, as read by the wiki-maintainer. */
export interface IndexedSourceContentRow {
  id: number;
  type: string;
  title: string;
  link: string | null;
  content: string | null;
}

/**
 * A connected external account (one row per provider). Carries OAuth secrets for
 * oauth2 connectors; a basic-auth connector instead stores its declared connect
 * form (host/username/password …) as a JSON object in `auth_config`.
 */
export interface ConnectorAccountRow {
  id: number;
  provider: string;
  account_email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expiry: string | null;
  scopes: string | null;
  client_id: string | null;
  client_secret: string | null;
  /** Basic-auth credentials as a JSON object string, or null for OAuth accounts. */
  auth_config: string | null;
  status: string;
  created_at: string;
}

/**
 * One row of the connector ledger (#17/#19): the last-seen content hash for an
 * external item plus the logical source + revision it materialized. Keyed by
 * (account_id, kind, external_id).
 */
export interface ConnectorItemRow {
  account_id: number;
  kind: string;
  external_id: string;
  content_hash: string | null;
  source_id: number | null;
  /** The revision this item last materialized to (#19); null on legacy rows. */
  source_revision_id: number | null;
  last_seen_at: string;
}

/** Per-kind sync cursor + schedule for a connected account. */
export interface ConnectorSyncStateRow {
  account_id: number;
  kind: string;
  enabled: number;
  interval_minutes: number;
  sync_token: string | null;
  last_synced_at: string | null;
  last_status: string | null;
  /** JSON coverage config (#68): window, content mode, backfill, calendars. */
  config: string;
}

/** Aggregate coverage stats for a kind, derived from the connector ledger (#68). */
export interface ConnectorCoverageStats {
  /** Distinct external items indexed for this kind. */
  itemCount: number;
  /** Oldest indexed item's date (ISO), parsed from the materialized source. */
  oldestIndexed: string | null;
}

/** An active observation with its embedding and owning-entity context, for retrieval. */
export interface ObservationWithVector {
  id: number;
  entity_id: number;
  entity_name: string;
  entity_type: EntityType;
  text: string;
  confidence: number;
  source_id: number | null;
  vector: Float32Array;
}

/** A persisted wiki page body with its embedding and entity context, for retrieval. */
export interface WikiPageWithVector {
  entity_id: number;
  entity_name: string;
  entity_type: EntityType;
  slug: string;
  body: string;
  vector: Float32Array;
}

/** A compiled wiki page body joined with its entity's display fields. */
export interface WikiPageBody {
  entity_id: number;
  entity_name: string;
  slug: string;
  type: string;
  body: string;
}

/** Who last wrote a page's prose: the in-app maintainer or the user's coding agent. */
export type WikiAuthor = "in-app" | "agent";

/**
 * How the wiki is maintained. `in-app` (default) is today's behavior — the
 * in-app maintainer auto-rewrites stale pages. `external` pauses that paid
 * rewrite so the user's own coding agent owns it (ingestion still marks pages
 * stale). `hybrid` allows both.
 */
export type WikiMaintenanceMode = "in-app" | "external" | "hybrid";

/** A compiled page with its maintenance-ledger columns (hash, author, quality). */
export interface WikiPageMeta {
  entity_id: number;
  body: string;
  body_hash: string | null;
  authored_by: WikiAuthor;
  quality: number | null;
  updated_at: string;
}

/** A wiki page the writer created or rewrote in one regeneration pass. */
export interface WikiChange {
  entityId: number;
  name: string;
  type: string;
  slug: string;
  /** Path relative to the data dir (git repo root), e.g. wiki/person/ada.md. */
  filePath: string;
  kind: "created" | "updated";
  /** Documents that made this page stale and so caused this change. */
  sourceIds: number[];
}

/** A single agentic wiki-maintainer run (one page regeneration). */
/** Who drove a wiki run: the in-app maintainer, or the user's own coding agent. */
export type WikiRunAuthor = "in-app" | "agent";

export interface WikiRunRow {
  id: number;
  entity_id: number | null;
  source_id: number | null;
  name: string;
  type: string;
  slug: string | null;
  status: "running" | "done" | "failed";
  author: WikiRunAuthor;
  created_at: string;
  finished_at: string | null;
}

export type WikiRunEventKind = "reasoning" | "tool-call" | "tool-result" | "text";

/** One ordered step in a run's transcript: reasoning, a tool call/result, or text. */
export interface WikiRunEventRow {
  id: number;
  run_id: number;
  seq: number;
  kind: WikiRunEventKind;
  tool_name: string | null;
  payload: string;
  created_at: string;
}

/** One file changed in a recorded wiki commit, attributed to a source document. */
export interface SourceChangeRow {
  hash: string;
  subject: string;
  committedAt: string;
  filePath: string;
  kind: "created" | "updated";
  entityName: string | null;
  entitySlug: string | null;
}

/** A claim's effective date: when it became true (validFrom), else when it was recorded. */
export function effectiveDate(o: { valid_from: string | null; created_at: string }): string {
  return o.valid_from ?? o.created_at;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "entity"
  );
}

/** Defensively parse a stored attendees JSON column into a string array (#26). */
function safeParseAttendees(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

/** Shift a YYYY-MM-DD date by `days` (UTC), used for the calendar-match window (#85). */
function shiftIsoDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Lowercase word tokens (≥3 chars) for fuzzy title comparison (#85). */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((t) => t.length >= 3),
  );
}

/** Jaccard similarity of two token sets in [0,1] (#85). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export class KnowledgeStore {
  constructor(readonly db: MeosDatabase) {}

  // --- sources & chunks ---

  createSource(input: {
    type: string;
    title: string;
    path?: string;
    mime?: string;
    content: string;
    /**
     * The unnormalized source text, stored alongside `content` so future
     * parsers can be re-run without re-reading the original file. Optional;
     * when omitted, `raw_content` stays null and `content` is the only copy.
     */
    rawContent?: string;
    /** Override the per-type visibility defaults (rarely needed). */
    visibility?: Partial<SourceVisibility>;
  }): number {
    // Apply the per-source-type visibility defaults at creation (mirrors the
    // migration-18 backfill so new and existing rows agree); callers may override.
    const v = { ...defaultVisibilityForType(input.type), ...input.visibility };
    const result = this.db
      .prepare(
        `INSERT INTO sources
           (type, title, path, mime, content, raw_content,
            searchable, answerable, wiki_eligible, syncable, exportable, activity_visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.type,
        input.title,
        input.path ?? null,
        input.mime ?? null,
        input.content,
        input.rawContent ?? null,
        v.searchable ? 1 : 0,
        v.answerable ? 1 : 0,
        v.wikiEligible ? 1 : 0,
        v.syncable ? 1 : 0,
        v.exportable ? 1 : 0,
        v.activityVisible ? 1 : 0,
      );
    return Number(result.lastInsertRowid);
  }

  /** A source's six surface permissions (defaults to fully permissive if unknown). */
  sourceVisibility(id: number): SourceVisibility {
    const row = this.db
      .prepare(
        `SELECT searchable, answerable, wiki_eligible, syncable, exportable, activity_visible
         FROM sources WHERE id = ?`,
      )
      .get(id) as
      | {
          searchable: number;
          answerable: number;
          wiki_eligible: number;
          syncable: number;
          exportable: number;
          activity_visible: number;
        }
      | undefined;
    if (!row) return defaultVisibilityForType("");
    return {
      searchable: row.searchable === 1,
      answerable: row.answerable === 1,
      wikiEligible: row.wiki_eligible === 1,
      syncable: row.syncable === 1,
      exportable: row.exportable === 1,
      activityVisible: row.activity_visible === 1,
    };
  }

  /** Set a source's visibility flags (partial update; unset flags are left as-is). */
  setSourceVisibility(id: number, patch: Partial<SourceVisibility>): void {
    const cols: Record<keyof SourceVisibility, string> = {
      searchable: "searchable",
      answerable: "answerable",
      wikiEligible: "wiki_eligible",
      syncable: "syncable",
      exportable: "exportable",
      activityVisible: "activity_visible",
    };
    const sets: string[] = [];
    const vals: number[] = [];
    for (const [key, col] of Object.entries(cols) as Array<[keyof SourceVisibility, string]>) {
      const value = patch[key];
      if (value !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(value ? 1 : 0);
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE sources SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  /** The set of source ids excluded from a given surface (flag = 0). */
  private sourceIdsWhere(flag: string): Set<number> {
    const rows = this.db.prepare(`SELECT id FROM sources WHERE ${flag} = 0`).all() as Array<{
      id: number;
    }>;
    return new Set(rows.map((r) => r.id));
  }

  /** Source ids that may NOT be used as retrieval candidates. */
  nonSearchableSourceIds(): Set<number> {
    return this.sourceIdsWhere("searchable");
  }

  /** Source ids that may NOT back a chat answer's citations. */
  nonAnswerableSourceIds(): Set<number> {
    return this.sourceIdsWhere("answerable");
  }

  getSourceTitle(id: number): string | undefined {
    const row = this.db.prepare("SELECT title FROM sources WHERE id = ?").get(id) as
      | { title: string }
      | undefined;
    return row?.title;
  }

  /** A source's full extracted text — used to locate a quote's char span. */
  getSourceContent(id: number): string | undefined {
    const row = this.db.prepare("SELECT content FROM sources WHERE id = ?").get(id) as
      | { content: string | null }
      | undefined;
    return row?.content ?? undefined;
  }

  /** A source's raw (unnormalized) text, when stored — lets parsers be re-run later. */
  getSourceRawContent(id: number): string | undefined {
    const row = this.db.prepare("SELECT raw_content FROM sources WHERE id = ?").get(id) as
      | { raw_content: string | null }
      | undefined;
    return row?.raw_content ?? undefined;
  }

  /** A source's type (file/image/conversation/session…) — drives source quality and tiering. */
  getSourceType(id: number): string | undefined {
    const row = this.db.prepare("SELECT type FROM sources WHERE id = ?").get(id) as
      | { type: string }
      | undefined;
    return row?.type;
  }

  /** Set a source's title — kept in sync when a meeting note is edited (#26). */
  updateSourceTitle(id: number, title: string): void {
    this.db.prepare("UPDATE sources SET title = ? WHERE id = ?").run(title, id);
  }

  /**
   * Synced calendar events matching `query`, for `@`-mention autocomplete. Reads
   * the materialized `google:calendar` sources (each event is one source whose
   * `raw_content` is the normalized {@link CalendarEventItem}) and parses out the
   * start, attendees, and deep link. Returns nothing when Calendar isn't
   * connected. Soonest-or-most-recent first; a malformed payload degrades to
   * title + link only.
   */
  listCalendarEvents(query = "", limit = 8): CalendarEventRef[] {
    const q = query.trim().toLowerCase();
    const rows = this.db
      .prepare(
        `SELECT s.id AS id, s.title AS title, s.path AS path, s.raw_content AS raw_content,
                ci.external_id AS external_id
         FROM sources s
         LEFT JOIN connector_items ci ON ci.source_id = s.id AND ci.kind = 'calendar'
         WHERE s.type = 'google:calendar' AND (? = '' OR lower(s.title) LIKE ?)
         ORDER BY s.id DESC
         LIMIT ?`,
      )
      .all(q, `%${q}%`, Math.max(limit * 4, limit)) as Array<{
      id: number;
      title: string;
      path: string | null;
      raw_content: string | null;
      external_id: string | null;
    }>;
    const events = rows.map((r): CalendarEventRef => {
      let start: string | null = null;
      let attendees: string[] = [];
      let htmlLink = r.path ?? "https://calendar.google.com/";
      if (r.raw_content) {
        try {
          const e = JSON.parse(r.raw_content) as CalendarEventItem;
          start = e.start ?? null;
          attendees = (e.attendees ?? [])
            .map((a) => a.name?.trim() || a.email)
            .filter((name): name is string => Boolean(name));
          if (e.htmlLink) htmlLink = e.htmlLink;
        } catch {
          /* keep title + link only */
        }
      }
      return {
        sourceId: r.id,
        externalId: r.external_id,
        title: r.title,
        start,
        attendees,
        htmlLink,
      };
    });
    // Sort by start (most recent / upcoming first); undated events sink to the end.
    events.sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""));
    return events.slice(0, limit);
  }

  /**
   * Resolve a single `google:calendar` event source to its normalized ref (#85),
   * for surfacing an auto-linked event in a meeting detail. Returns undefined when
   * the source is missing or isn't a calendar event.
   */
  getCalendarEventRef(sourceId: number): CalendarEventRef | undefined {
    const row = this.db
      .prepare(
        `SELECT s.id AS id, s.title AS title, s.path AS path, s.raw_content AS raw_content,
                ci.external_id AS external_id
         FROM sources s
         LEFT JOIN connector_items ci ON ci.source_id = s.id AND ci.kind = 'calendar'
         WHERE s.id = ? AND s.type = 'google:calendar'`,
      )
      .get(sourceId) as
      | {
          id: number;
          title: string;
          path: string | null;
          raw_content: string | null;
          external_id: string | null;
        }
      | undefined;
    if (!row) return undefined;
    let start: string | null = null;
    let attendees: string[] = [];
    let htmlLink = row.path ?? "https://calendar.google.com/";
    if (row.raw_content) {
      try {
        const e = JSON.parse(row.raw_content) as CalendarEventItem;
        start = e.start ?? null;
        attendees = (e.attendees ?? [])
          .map((a) => a.name?.trim() || a.email)
          .filter((name): name is string => Boolean(name));
        if (e.htmlLink) htmlLink = e.htmlLink;
      } catch {
        /* keep title + link only */
      }
    }
    return {
      sourceId: row.id,
      externalId: row.external_id,
      title: row.title,
      start,
      attendees,
      htmlLink,
    };
  }

  /**
   * Best-effort match of a detected meeting to a synced calendar event (#85).
   * Scores every `google:calendar` event source within ±1 day of `date` by title
   * similarity (token overlap) and attendee overlap, returning the strongest match
   * above a small floor — or undefined when no calendar is connected / nothing is
   * close enough. Read-only and side-effect-free; the caller persists the link.
   */
  findCalendarEventForMeeting(args: {
    date: string;
    title: string;
    attendees: string[];
  }): { sourceId: number; score: number } | undefined {
    const day = args.date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return undefined;
    // ±1 day window around the meeting date (string compare on the YYYY-MM-DD prefix).
    const lower = shiftIsoDay(day, -1);
    const upper = shiftIsoDay(day, 1);

    // Pull a candidate set; titles are not used for SQL filtering (calendar
    // titles rarely match the note's title verbatim), so scan recent events.
    const candidates = this.listCalendarEvents("", 200);
    const noteTitleTokens = tokenize(args.title);
    const noteAttendees = new Set(
      args.attendees.map((a) => a.trim().toLowerCase()).filter(Boolean),
    );

    let best: { sourceId: number; score: number } | undefined;
    for (const ev of candidates) {
      const evDay = (ev.start ?? "").slice(0, 10);
      if (!evDay || evDay < lower || evDay > upper) continue;

      const evTitleTokens = tokenize(ev.title);
      const titleScore = jaccard(noteTitleTokens, evTitleTokens);

      const evAttendees = new Set(ev.attendees.map((a) => a.trim().toLowerCase()).filter(Boolean));
      let attendeeOverlap = 0;
      if (noteAttendees.size > 0 && evAttendees.size > 0) {
        let hits = 0;
        for (const a of noteAttendees) if (evAttendees.has(a)) hits++;
        attendeeOverlap = hits / Math.min(noteAttendees.size, evAttendees.size);
      }
      // Same-day events get a small prior even with weak title/attendee signal.
      const dayScore = evDay === day ? 0.2 : 0.05;
      const score = 0.45 * titleScore + 0.45 * attendeeOverlap + dayScore;

      if (score > (best?.score ?? 0)) best = { sourceId: ev.sourceId, score };
    }
    // Require some real signal beyond the day prior alone.
    return best && best.score >= 0.35 ? best : undefined;
  }

  // --- meeting notes (#26) ---

  /**
   * Upsert the structured fields of a meeting note (its date + attendees). The
   * markdown body lives on `sources.content` (so it rides the whole revision/
   * chunk/extraction chain); only the queryable fields live here.
   */
  upsertMeetingNote(input: {
    sourceId: number;
    meetingDate?: string | null;
    attendees?: string[];
    /** Classifier confidence for an auto-detected meeting; null/omitted for manual (#85). */
    detectionConfidence?: number | null;
    /** 'auto' when detected at ingest, 'manual' for the explicit create path. Defaults 'manual'. */
    detectionMethod?: "auto" | "manual";
    /** A matched google:calendar event source to link, or null to clear (#85). */
    linkedCalendarSourceId?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO meeting_notes
           (source_id, meeting_date, attendees, detection_confidence, detection_method,
            linked_calendar_source_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           meeting_date = excluded.meeting_date,
           attendees = excluded.attendees,
           detection_confidence = excluded.detection_confidence,
           detection_method = excluded.detection_method,
           linked_calendar_source_id = excluded.linked_calendar_source_id,
           updated_at = datetime('now')`,
      )
      .run(
        input.sourceId,
        input.meetingDate ?? null,
        JSON.stringify(input.attendees ?? []),
        input.detectionConfidence ?? null,
        input.detectionMethod ?? "manual",
        input.linkedCalendarSourceId ?? null,
      );
  }

  /** The structured fields of a meeting note, or undefined if the source isn't one. */
  getMeetingNote(sourceId: number): MeetingNoteRow | undefined {
    const row = this.db.prepare("SELECT * FROM meeting_notes WHERE source_id = ?").get(sourceId) as
      | {
          source_id: number;
          meeting_date: string | null;
          attendees: string;
          detection_confidence: number | null;
          detection_method: "auto" | "manual";
          linked_calendar_source_id: number | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return { ...row, attendees: safeParseAttendees(row.attendees) };
  }

  /** Every meeting-note source, newest first — for the meeting list view. */
  listMeetingNotes(): Array<MeetingNoteRow & { title: string }> {
    const rows = this.db
      .prepare(
        `SELECT m.*, s.title AS title
         FROM meeting_notes m JOIN sources s ON s.id = m.source_id
         ORDER BY COALESCE(m.meeting_date, m.created_at) DESC, m.source_id DESC`,
      )
      .all() as Array<{
      source_id: number;
      meeting_date: string | null;
      attendees: string;
      detection_confidence: number | null;
      detection_method: "auto" | "manual";
      linked_calendar_source_id: number | null;
      created_at: string;
      updated_at: string;
      title: string;
    }>;
    return rows.map((r) => ({ ...r, attendees: safeParseAttendees(r.attendees) }));
  }

  /**
   * Replace a meeting's pending (still-"suggested") link suggestions with a fresh
   * set, leaving any the user already accepted/rejected untouched (their decision
   * is durable across reprocesses). Each suggestion is keyed by (source, entity);
   * a fresh suggestion for a pair the user already ruled on is skipped.
   */
  replaceMeetingLinkSuggestions(
    sourceId: number,
    suggestions: Array<{
      entityId: number;
      rationale: string;
      method: MeetingLinkMethod;
    }>,
  ): void {
    const run = this.db.transaction(() => {
      // Drop only the pending ones; accepted/rejected decisions persist.
      this.db
        .prepare(
          "DELETE FROM meeting_link_suggestions WHERE source_id = ? AND status = 'suggested'",
        )
        .run(sourceId);
      // Pairs the user already decided on — never re-suggest these.
      const decided = new Set(
        (
          this.db
            .prepare(
              "SELECT entity_id FROM meeting_link_suggestions WHERE source_id = ? AND status != 'suggested'",
            )
            .all(sourceId) as Array<{ entity_id: number }>
        ).map((r) => r.entity_id),
      );
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO meeting_link_suggestions
           (source_id, entity_id, rationale, method, status)
         VALUES (?, ?, ?, ?, 'suggested')`,
      );
      for (const s of suggestions) {
        if (decided.has(s.entityId)) continue;
        insert.run(sourceId, s.entityId, s.rationale, s.method);
      }
    });
    run();
  }

  /**
   * The active observations a source supports, joined with their entity name —
   * the structured context (decisions / tasks / risks / open questions) a meeting
   * detail view groups by `kind`. Uses the observation_sources provenance table
   * (plus the primary source_id) so a claim a meeting *reinforced* (the merge
   * collapses a near-duplicate into an existing observation) still surfaces as
   * that meeting's evidence, not just claims it was the first to create. Newest
   * first.
   */
  observationsForSource(sourceId: number): Array<{
    id: number;
    kind: string;
    text: string;
    source_quote: string | null;
    entity_name: string;
  }> {
    return this.db
      .prepare(
        `SELECT o.id, o.kind, o.text, o.source_quote, e.name AS entity_name
         FROM observations o JOIN entities e ON e.id = o.entity_id
         WHERE o.status = 'active'
           AND (o.source_id = ?
                OR EXISTS (SELECT 1 FROM observation_sources os
                           WHERE os.observation_id = o.id AND os.source_id = ?))
         ORDER BY o.id DESC`,
      )
      .all(sourceId, sourceId) as Array<{
      id: number;
      kind: string;
      text: string;
      source_quote: string | null;
      entity_name: string;
    }>;
  }

  /** A meeting's link suggestions (joined with their entities), for the review UI. */
  meetingLinkSuggestions(sourceId: number): MeetingLinkSuggestionRow[] {
    return this.db
      .prepare(
        `SELECT l.id, l.source_id, l.entity_id, l.rationale, l.method, l.status, l.created_at,
                e.name AS entity_name, e.type AS entity_type, e.slug AS entity_slug
         FROM meeting_link_suggestions l
         JOIN entities e ON e.id = l.entity_id
         WHERE l.source_id = ?
         ORDER BY CASE l.status WHEN 'suggested' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
                  e.type, e.name`,
      )
      .all(sourceId) as MeetingLinkSuggestionRow[];
  }

  /**
   * Record the user's review of a single suggestion (accept or reject). The
   * decision is durable: a later reprocess (#16) will not re-suggest or clobber
   * a pair the user has ruled on. Returns false if the suggestion id is unknown.
   */
  reviewMeetingLinkSuggestion(id: number, status: "accepted" | "rejected"): boolean {
    const result = this.db
      .prepare("UPDATE meeting_link_suggestions SET status = ? WHERE id = ?")
      .run(status, id);
    return result.changes > 0;
  }

  /**
   * Persist a source's chunks with their embeddings and, when provided, the
   * structure-aware metadata (#14) that lets a result navigate chunk → section →
   * source and lets citations cite a page/section/span. The metadata fields are
   * all optional, so existing callers passing `{ text, embedding }` keep working
   * and the extra columns stay null.
   */
  addChunks(sourceId: number, chunks: ChunkInput[], sourceRevisionId?: number): void {
    const insert = this.db.prepare(
      `INSERT INTO chunks
         (source_id, seq, text, embedding, source_block_ids, section_title,
          page_start, page_end, char_start, char_end, token_estimate, content_type,
          source_revision_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAll = this.db.transaction(() => {
      chunks.forEach((chunk, seq) => {
        insert.run(
          sourceId,
          seq,
          chunk.text,
          serializeVector(chunk.embedding),
          chunk.sourceBlockIds ? JSON.stringify(chunk.sourceBlockIds) : null,
          chunk.sectionTitle ?? null,
          chunk.pageStart ?? null,
          chunk.pageEnd ?? null,
          chunk.charStart ?? null,
          chunk.charEnd ?? null,
          chunk.tokenEstimate ?? null,
          chunk.contentType ?? null,
          sourceRevisionId ?? null,
        );
      });
    });
    insertAll();
  }

  /** A chunk's structure-aware metadata (#14), for citation/navigation. */
  chunkMetadata(chunkId: number): ChunkMetadataRow | undefined {
    return this.db
      .prepare(
        `SELECT id, source_id, seq, source_block_ids, section_title,
                page_start, page_end, char_start, char_end, token_estimate,
                content_type, source_revision_id
         FROM chunks WHERE id = ?`,
      )
      .get(chunkId) as ChunkMetadataRow | undefined;
  }

  /** The chunks belonging to a source, in document order — chunk ↔ source navigation. */
  chunksForSource(sourceId: number): ChunkMetadataRow[] {
    return this.db
      .prepare(
        `SELECT id, source_id, seq, source_block_ids, section_title,
                page_start, page_end, char_start, char_end, token_estimate,
                content_type, source_revision_id
         FROM chunks WHERE source_id = ? ORDER BY seq`,
      )
      .all(sourceId) as ChunkMetadataRow[];
  }

  allChunks(): ChunkWithVector[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.source_id, c.text, c.embedding,
                c.section_title, c.page_start, c.page_end, c.char_start, c.char_end,
                s.title AS source_title, s.path AS source_path
         FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE c.embedding IS NOT NULL`,
      )
      .all() as Array<{
      id: number;
      source_id: number;
      text: string;
      embedding: Buffer;
      section_title: string | null;
      page_start: number | null;
      page_end: number | null;
      char_start: number | null;
      char_end: number | null;
      source_title: string;
      source_path: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      source_id: row.source_id,
      source_title: row.source_title,
      source_path: row.source_path,
      text: row.text,
      vector: deserializeVector(row.embedding),
      section_title: row.section_title,
      page_start: row.page_start,
      page_end: row.page_end,
      char_start: row.char_start,
      char_end: row.char_end,
    }));
  }

  getSource(id: number): SourceRef | undefined {
    return this.db.prepare("SELECT id, title, path, type FROM sources WHERE id = ?").get(id) as
      | SourceRef
      | undefined;
  }

  /**
   * The most recent source row recorded at this exact path — the logical source a
   * watched-file re-ingest should advance (a new revision) instead of forking a
   * fresh source. Newest id wins so legacy duplicate rows resolve to the latest.
   */
  findSourceByPath(path: string): { id: number } | undefined {
    return this.db
      .prepare("SELECT id FROM sources WHERE path = ? ORDER BY id DESC LIMIT 1")
      .get(path) as { id: number } | undefined;
  }

  /**
   * Assign (or change) a source's logical-source key. The meeting flow (#26)
   * uses this to key a just-created note by its synthetic "meeting:<id>" path so
   * a later reprocess advances the same source's revision history (#16).
   */
  setSourcePath(id: number, path: string): void {
    this.db.prepare("UPDATE sources SET path = ? WHERE id = ?").run(path, id);
  }

  /** Replace a source's stored content (and optional raw bytes) on a re-ingest. */
  updateSourceContent(id: number, content: string, rawContent?: string): void {
    this.db
      .prepare(
        "UPDATE sources SET content = ?, raw_content = COALESCE(?, raw_content), title = title WHERE id = ?",
      )
      .run(content, rawContent ?? null, id);
  }

  /** Remove a source's chunks (and FTS shadow rows via trigger) before re-chunking a new revision. */
  clearChunksForSource(sourceId: number): void {
    this.db.prepare("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
  }

  /**
   * A watched file went away — mark its logical source's latest revision gone
   * (`missing` when the file vanished, `deleted` when explicitly removed) and
   * flag the wiki pages whose facts are now backed only by an obsolete revision.
   * Returns the marked revision id, or undefined when no source matches the path.
   * The `ingested_files` ledger is untouched so the content-hash dedup still works
   * if the file reappears.
   */
  markSourceGoneByPath(path: string, reason: "missing" | "deleted"): number | undefined {
    const source = this.findSourceByPath(path);
    if (!source) return undefined;
    const revisionId = this.markSourceGone(source.id, reason);
    for (const id of this.entityIdsWithStaleBackedFacts()) this.markWikiStale(id);
    return revisionId;
  }

  /**
   * Sources whose path lies under a (now-unwatched) folder. Used to mark a whole
   * removed watched folder's documents `deleted` in one pass.
   */
  sourcesUnderPath(folderPath: string): Array<{ id: number; path: string }> {
    const prefix = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
    return this.db
      .prepare("SELECT id, path FROM sources WHERE path IS NOT NULL AND path LIKE ? ESCAPE '\\'")
      .all(prefix.replace(/[%_\\]/g, "\\$&") + "%") as Array<{ id: number; path: string }>;
  }

  /** Sources whose recorded path is only a basename (legacy ingest bug). */
  sourcesWithRelativePaths(): Array<{ id: number; path: string }> {
    return this.db
      .prepare("SELECT id, path FROM sources WHERE path IS NOT NULL AND path NOT LIKE '/%'")
      .all() as Array<{ id: number; path: string }>;
  }

  updateSourcePath(id: number, absolutePath: string): void {
    this.db.prepare("UPDATE sources SET path = ? WHERE id = ?").run(absolutePath, id);
  }

  /** Distinct sources backing an entity's active observations. */
  sourcesForEntity(entityId: number): SourceRef[] {
    return this.db
      .prepare(
        `SELECT DISTINCT s.id, s.title, s.path, s.type
         FROM observations o JOIN sources s ON s.id = o.source_id
         WHERE o.entity_id = ? AND o.status = 'active'
         ORDER BY s.title`,
      )
      .all(entityId) as SourceRef[];
  }

  /**
   * The locally-indexed connector items backing an entity's active facts, with
   * their normalized content — the raw source material the wiki-maintainer reads
   * (as files in its sandbox) when writing the entity's page. Newest first.
   */
  indexedSourcesForEntity(entityId: number): IndexedSourceContentRow[] {
    return this.db
      .prepare(
        `SELECT DISTINCT s.id AS id, s.type AS type, s.title AS title, s.path AS link, s.content AS content
         FROM observations o JOIN sources s ON s.id = o.source_id
         WHERE o.entity_id = ? AND o.status = 'active' AND s.type LIKE '%:%'
         ORDER BY s.created_at DESC, s.id DESC`,
      )
      .all(entityId) as IndexedSourceContentRow[];
  }

  // --- indexed sources (the Sources tab) -------------------------------
  //
  // Every connector item (a contact, event, task, email) is a `sources` row
  // whose `type` names its kind ("google:gmail"). The Sources tab browses these
  // items as first-class entities: each with a deep link to open the original
  // and links to the wiki entities it touches (its correspondents/attendees).
  // A source `type` carries a colon only for connectors — the built-in origins
  // (file/image/conversation/session/profile_context) never do — so `LIKE '%:%'`
  // selects exactly the externally-indexed items.

  /**
   * All locally-indexed connector items, newest first, each tagged with its
   * latest-revision status and the entities it links to. Drives `GET /api/sources`.
   */
  listIndexedSources(): IndexedSourceRow[] {
    const sources = this.db
      .prepare(
        `SELECT s.id, s.type, s.title, s.path, s.created_at,
                (SELECT sr.status FROM source_revisions sr
                  WHERE sr.source_id = s.id ORDER BY sr.revision DESC LIMIT 1) AS status
         FROM sources s
         WHERE s.type LIKE '%:%'
         ORDER BY s.created_at DESC, s.id DESC`,
      )
      .all() as Array<{
      id: number;
      type: string;
      title: string;
      path: string | null;
      created_at: string | null;
      status: string | null;
    }>;

    // One pass for every (connector source → entity) link, grouped in memory so
    // the listing is two queries regardless of how many items are indexed.
    const links = this.db
      .prepare(
        `SELECT o.source_id AS source_id, e.id AS id, e.type AS type, e.name AS name, e.slug AS slug,
                ${KnowledgeStore.HAS_PAGE_WORTHY_SQL} AS has_page
         FROM observations o
         JOIN sources src ON src.id = o.source_id AND src.type LIKE '%:%'
         JOIN entities e ON e.id = o.entity_id
         WHERE o.status = 'active'
         GROUP BY o.source_id, e.id, e.type, e.name, e.slug
         ORDER BY e.name COLLATE NOCASE`,
      )
      .all() as Array<{
      source_id: number;
      id: number;
      type: string;
      name: string;
      slug: string;
      has_page: number;
    }>;

    const bySource = new Map<number, IndexedEntityLinkRow[]>();
    for (const l of links) {
      const list = bySource.get(l.source_id) ?? [];
      list.push({ id: l.id, type: l.type, name: l.name, slug: l.slug, hasPage: l.has_page === 1 });
      bySource.set(l.source_id, list);
    }

    return sources.map((s) => ({
      ...this.splitSourceType(s.type),
      id: s.id,
      type: s.type,
      title: s.title,
      link: s.path,
      createdAt: s.created_at,
      status: s.status,
      linkedEntities: bySource.get(s.id) ?? [],
    }));
  }

  /**
   * One indexed item with its normalized content, linked entities, and the other
   * indexed items it connects to through a shared entity (email ↔ contact, event
   * ↔ attendee). Returns undefined for a non-connector or unknown source.
   */
  getIndexedSource(id: number): IndexedSourceDetailRow | undefined {
    const row = this.db
      .prepare(
        `SELECT s.id, s.type, s.title, s.path, s.created_at, s.content,
                (SELECT sr.status FROM source_revisions sr
                  WHERE sr.source_id = s.id ORDER BY sr.revision DESC LIMIT 1) AS status
         FROM sources s
         WHERE s.id = ? AND s.type LIKE '%:%'`,
      )
      .get(id) as
      | {
          id: number;
          type: string;
          title: string;
          path: string | null;
          created_at: string | null;
          content: string | null;
          status: string | null;
        }
      | undefined;
    if (!row) return undefined;

    const linkedEntities = this.db
      .prepare(
        `SELECT e.id AS id, e.type AS type, e.name AS name, e.slug AS slug,
                ${KnowledgeStore.HAS_PAGE_WORTHY_SQL} AS has_page
         FROM observations o
         JOIN entities e ON e.id = o.entity_id
         WHERE o.source_id = ? AND o.status = 'active'
         GROUP BY e.id, e.type, e.name, e.slug
         ORDER BY e.name COLLATE NOCASE`,
      )
      .all(id) as Array<{
      id: number;
      type: string;
      name: string;
      slug: string;
      has_page: number;
    }>;

    // Sibling items sharing any of this item's entities, with the entity name(s)
    // that connect them so the UI can explain the link ("via Jane Doe").
    const related = this.db
      .prepare(
        `SELECT s2.id AS id, s2.type AS type, s2.title AS title, s2.path AS path, e.name AS via
         FROM observations o1
         JOIN observations o2
           ON o2.entity_id = o1.entity_id AND o2.source_id <> o1.source_id AND o2.status = 'active'
         JOIN entities e ON e.id = o1.entity_id
         JOIN sources s2 ON s2.id = o2.source_id AND s2.type LIKE '%:%'
         WHERE o1.source_id = ? AND o1.status = 'active'
         GROUP BY s2.id, e.name
         ORDER BY s2.created_at DESC, s2.id DESC`,
      )
      .all(id) as Array<{
      id: number;
      type: string;
      title: string;
      path: string | null;
      via: string;
    }>;

    const byItem = new Map<number, RelatedSourceRow>();
    for (const r of related) {
      const existing = byItem.get(r.id);
      if (existing) {
        if (!existing.via.includes(r.via)) existing.via.push(r.via);
      } else {
        byItem.set(r.id, {
          id: r.id,
          ...this.splitSourceType(r.type),
          type: r.type,
          title: r.title,
          link: r.path,
          via: [r.via],
        });
      }
    }

    return {
      ...this.splitSourceType(row.type),
      id: row.id,
      type: row.type,
      title: row.title,
      link: row.path,
      createdAt: row.created_at,
      status: row.status,
      content: row.content,
      linkedEntities: linkedEntities.map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name,
        slug: e.slug,
        hasPage: e.has_page === 1,
      })),
      relatedSources: [...byItem.values()],
    };
  }

  /** Split a connector source type ("google:gmail") into provider + kind. */
  private splitSourceType(type: string): { provider: string; kind: string } {
    const idx = type.indexOf(":");
    if (idx === -1) return { provider: type, kind: type };
    return { provider: type.slice(0, idx), kind: type.slice(idx + 1) };
  }

  // --- source revisions (#16) ------------------------------------------

  /**
   * Open a new revision for a source and make it the live one: the prior `active`
   * revision (if any) becomes `superseded`, and the new row is inserted `active`
   * at the next monotonic revision number. Returns the new revision's id, which
   * the caller threads onto the chunks/observations/relationships it derives so a
   * fact can later be traced to — and flagged by — the exact version it came from.
   *
   * `status` defaults to `active`; pass `incomplete`/`failed` to record an
   * attempt without promoting it (the prior active stays live in that case).
   */
  createSourceRevision(input: {
    sourceId: number;
    contentHash?: string | null;
    rawContent?: string | null;
    normalizedContent?: string | null;
    status?: SourceRevisionStatus;
  }): number {
    const status = input.status ?? "active";
    const tx = this.db.transaction(() => {
      const next =
        (
          this.db
            .prepare("SELECT MAX(revision) AS m FROM source_revisions WHERE source_id = ?")
            .get(input.sourceId) as { m: number | null }
        ).m ?? 0;
      // Only a promoting revision retires the previous active one.
      if (status === "active") {
        this.db
          .prepare(
            "UPDATE source_revisions SET status = 'superseded' WHERE source_id = ? AND status = 'active'",
          )
          .run(input.sourceId);
      }
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO source_revisions
               (source_id, revision, status, content_hash, raw_content, normalized_content)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.sourceId,
            next + 1,
            status,
            input.contentHash ?? null,
            input.rawContent ?? null,
            input.normalizedContent ?? null,
          ).lastInsertRowid,
      );
      return id;
    });
    return tx();
  }

  /** A source's current `active` revision, if it has one. */
  activeRevision(sourceId: number): SourceRevisionRow | undefined {
    return this.db
      .prepare(
        `SELECT id, source_id, revision, status, content_hash, raw_content,
                normalized_content, created_at
         FROM source_revisions WHERE source_id = ? AND status = 'active'
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(sourceId) as SourceRevisionRow | undefined;
  }

  /** The most recent revision of a source regardless of status (live or retired). */
  latestRevision(sourceId: number): SourceRevisionRow | undefined {
    return this.db
      .prepare(
        `SELECT id, source_id, revision, status, content_hash, raw_content,
                normalized_content, created_at
         FROM source_revisions WHERE source_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(sourceId) as SourceRevisionRow | undefined;
  }

  getRevision(id: number): SourceRevisionRow | undefined {
    return this.db
      .prepare(
        `SELECT id, source_id, revision, status, content_hash, raw_content,
                normalized_content, created_at
         FROM source_revisions WHERE id = ?`,
      )
      .get(id) as SourceRevisionRow | undefined;
  }

  /** Every revision of a source, oldest first — provenance/history. */
  revisionsForSource(sourceId: number): SourceRevisionRow[] {
    return this.db
      .prepare(
        `SELECT id, source_id, revision, status, content_hash, raw_content,
                normalized_content, created_at
         FROM source_revisions WHERE source_id = ? ORDER BY revision`,
      )
      .all(sourceId) as SourceRevisionRow[];
  }

  /**
   * Sources that are indexed (an active revision exists) but carry no facts yet —
   * the agent's extraction queue under external wiki maintenance (#wiki-agent,
   * Option 2). "No facts" is judged via the provenance link (observation_sources),
   * so a source that only reinforced existing facts still counts as extracted.
   * Newest first, bounded.
   */
  sourcesAwaitingExtraction(
    limit = 100,
  ): Array<{ id: number; type: string; title: string; path: string | null; created_at: string }> {
    return this.db
      .prepare(
        `SELECT s.id, s.type, s.title, s.path, s.created_at
         FROM sources s
         WHERE EXISTS (
                 SELECT 1 FROM source_revisions r
                 WHERE r.source_id = s.id AND r.status = 'active'
               )
           AND NOT EXISTS (
                 SELECT 1 FROM observations o WHERE o.source_id = s.id
               )
           AND NOT EXISTS (
                 SELECT 1 FROM observation_sources os WHERE os.source_id = s.id
               )
         ORDER BY s.id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      type: string;
      title: string;
      path: string | null;
      created_at: string;
    }>;
  }

  /**
   * Look up a cached partial extraction (#15) by its full version-keyed identity.
   * A hit lets map-reduce skip the LLM call for that section; a miss (any version
   * component changed, or never extracted) returns undefined so it recomputes.
   * Returns the parsed Extraction, or undefined on miss / unparseable row.
   */
  getCachedExtraction(key: ExtractionCacheKey): Extraction | undefined {
    const row = this.db
      .prepare(
        `SELECT extraction FROM extraction_cache
         WHERE source_revision_id = ? AND content_hash = ? AND schema_version = ?
           AND prompt_version = ? AND model_id = ? AND profile_version = ?`,
      )
      .get(
        key.sourceRevisionId,
        key.contentHash,
        key.schemaVersion,
        key.promptVersion,
        key.modelId,
        key.profileVersion,
      ) as { extraction: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.extraction) as Extraction;
    } catch {
      return undefined;
    }
  }

  /**
   * Store a partial extraction in the cache (#15), keyed by revision + section
   * content hash + version tuple. Idempotent: re-storing the same key overwrites
   * (so a re-run with a real LLM result replaces any earlier placeholder). Records
   * the LLM `tokenUsage` the map call spent and which `strategy` owns it.
   */
  putCachedExtraction(
    key: ExtractionCacheKey,
    extraction: Extraction,
    strategy: ExtractionStrategy,
    tokenUsage = 0,
  ): void {
    this.db
      .prepare(
        `INSERT INTO extraction_cache
           (source_revision_id, content_hash, schema_version, prompt_version,
            model_id, profile_version, strategy, extraction, token_usage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_revision_id, content_hash, schema_version, prompt_version,
                     model_id, profile_version)
         DO UPDATE SET strategy = excluded.strategy,
                       extraction = excluded.extraction,
                       token_usage = excluded.token_usage`,
      )
      .run(
        key.sourceRevisionId,
        key.contentHash,
        key.schemaVersion,
        key.promptVersion,
        key.modelId,
        key.profileVersion,
        strategy,
        JSON.stringify(extraction),
        tokenUsage,
      );
  }

  /** Every cache row for a revision (telemetry/tests) — newest first. */
  extractionCacheForRevision(sourceRevisionId: number): ExtractionCacheRow[] {
    return this.db
      .prepare(
        `SELECT id, source_revision_id, content_hash, schema_version, prompt_version,
                model_id, profile_version, strategy, extraction, token_usage, created_at
         FROM extraction_cache WHERE source_revision_id = ? ORDER BY id DESC`,
      )
      .all(sourceRevisionId) as ExtractionCacheRow[];
  }

  /** Set a revision's lifecycle status (active|missing|deleted|superseded|failed|incomplete). */
  setRevisionStatus(id: number, status: SourceRevisionStatus): void {
    this.db.prepare("UPDATE source_revisions SET status = ? WHERE id = ?").run(status, id);
  }

  /**
   * Mark a logical source's latest revision as gone — `missing` (file vanished on
   * disk) or `deleted` (explicit removal). The active revision is retired in place
   * so nothing newer is overwritten. Returns the affected revision id, or
   * undefined when the source has no revisions. The caller then re-checks the
   * facts that revision backed (see {@link entityIdsBackedOnlyByRevision}).
   */
  markSourceGone(sourceId: number, reason: "missing" | "deleted"): number | undefined {
    const latest = this.latestRevision(sourceId);
    if (!latest) return undefined;
    // Only retire a still-live revision; leave already-superseded history alone.
    if (latest.status === "active" || latest.status === "incomplete") {
      this.setRevisionStatus(latest.id, reason);
    }
    return latest.id;
  }

  /** True when this revision is no longer a current/usable source of truth. */
  private static isObsolete(status: SourceRevisionStatus): boolean {
    return status === "superseded" || status === "deleted" || status === "missing";
  }

  /**
   * Distinct entities owning at least one active observation whose every backing
   * revision is obsolete (superseded/deleted/missing) — i.e. the claim is now
   * supported only by stale provenance. Used to flag the wiki pages that need a
   * "backed by an outdated source" treatment after a re-ingest or deletion.
   */
  entityIdsWithStaleBackedFacts(): number[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT o.entity_id AS id
         FROM observations o
         WHERE o.status = 'active' AND o.source_revision_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM source_revisions sr
             WHERE sr.id = o.source_revision_id AND sr.status = 'active'
           )`,
      )
      .all() as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  /**
   * Active observations whose only support is an obsolete revision, with their
   * owning-entity context and the worst backing status — the query the UI uses to
   * render a stale/deleted indicator on a fact. (Each observation links a single
   * revision today, so "only support" reduces to "that revision is obsolete".)
   */
  staleBackedObservations(): StaleBackedObservationRow[] {
    return this.db
      .prepare(
        `SELECT o.id, o.entity_id, o.text, e.name AS entity_name, e.slug AS entity_slug,
                sr.status AS revision_status
         FROM observations o
         JOIN source_revisions sr ON sr.id = o.source_revision_id
         JOIN entities e ON e.id = o.entity_id
         WHERE o.status = 'active' AND sr.status IN ('superseded','deleted','missing')
         ORDER BY o.entity_id, o.id`,
      )
      .all() as StaleBackedObservationRow[];
  }

  /**
   * Per active observation of an entity, the status of its backing revision when
   * that revision is obsolete (superseded/deleted/missing) — keyed by observation
   * id. Observations backed by an active revision (or no revision) are absent, so
   * the wiki page can flag exactly the facts that came from an outdated source.
   */
  staleBackingByEntity(entityId: number): Map<number, SourceRevisionStatus> {
    const rows = this.db
      .prepare(
        `SELECT o.id, sr.status
         FROM observations o
         JOIN source_revisions sr ON sr.id = o.source_revision_id
         WHERE o.entity_id = ? AND o.status = 'active'
           AND sr.status IN ('superseded','deleted','missing')`,
      )
      .all(entityId) as Array<{ id: number; status: SourceRevisionStatus }>;
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  /** Entity ids whose active facts are backed only by an obsolete revision. */
  entityIdsBackedOnlyByRevision(revisionId: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT entity_id AS id FROM observations
         WHERE status = 'active' AND source_revision_id = ?`,
      )
      .all(revisionId) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  /**
   * Reclaim the raw/normalized content blobs of revisions that are no longer
   * needed for provenance or retries: nulls the blobs of `superseded`/`deleted`
   * revisions that back no active observation, relationship, or chunk. The
   * revision rows themselves are kept (cheap, and they preserve the lineage); only
   * the heavy content is dropped. Never touches `active`, `missing`, `failed`, or
   * `incomplete` revisions (a missing file may come back; a failed/incomplete one
   * may be retried). Returns how many revisions were GC'd.
   */
  gcOrphanedRevisionBlobs(): number {
    const result = this.db
      .prepare(
        `UPDATE source_revisions
           SET raw_content = NULL, normalized_content = NULL
         WHERE status IN ('superseded','deleted')
           AND (raw_content IS NOT NULL OR normalized_content IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.source_revision_id = source_revisions.id AND o.status = 'active')
           AND NOT EXISTS (SELECT 1 FROM relationships r WHERE r.source_revision_id = source_revisions.id AND r.status = 'active')
           AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.source_revision_id = source_revisions.id)`,
      )
      .run();
    return result.changes;
  }

  // --- inbox ---

  createInboxItem(title: string, sourceId?: number): number {
    const result = this.db
      .prepare("INSERT INTO inbox_items (title, source_id) VALUES (?, ?)")
      .run(title, sourceId ?? null);
    return Number(result.lastInsertRowid);
  }

  /**
   * One feed row per watched file, keyed by path. The first time a file is
   * seen it inserts a row; every later change resets that same row to 'queued'
   * (clearing the stale detail) and bumps its revision, so the file moves up
   * the feed instead of spawning a duplicate. `isUpdate` lets callers and the
   * UI distinguish "newly ingested" from "changed and re-read".
   */
  upsertInboxItemForFile(filePath: string, title: string): { id: number; isUpdate: boolean } {
    const existing = this.db.prepare("SELECT id FROM inbox_items WHERE path = ?").get(filePath) as
      | { id: number }
      | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE inbox_items
           SET title = ?, status = 'queued', detail = NULL, revision = revision + 1,
               updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(title, existing.id);
      return { id: existing.id, isUpdate: true };
    }
    const result = this.db
      .prepare("INSERT INTO inbox_items (title, path) VALUES (?, ?)")
      .run(title, filePath);
    return { id: Number(result.lastInsertRowid), isUpdate: false };
  }

  updateInboxItem(id: number, status: string, detail?: string, sourceId?: number): void {
    this.db
      .prepare(
        `UPDATE inbox_items
         SET status = ?, detail = COALESCE(?, detail), source_id = COALESCE(?, source_id),
             updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(status, detail ?? null, sourceId ?? null, id);
  }

  listInbox(limit = 100): InboxItemRow[] {
    // Most recently touched first, so a file that just changed rises to the top.
    return this.db
      .prepare("SELECT * FROM inbox_items ORDER BY updated_at DESC, id DESC LIMIT ?")
      .all(limit) as InboxItemRow[];
  }

  /**
   * Local-file indexing health for the source dashboard (#87): how many inbox
   * items are in each meaningful bucket, plus the most recent successful index
   * time. Folds the fine-grained inbox statuses into the product buckets the UI
   * shows (indexed / failed / skipped / pending). Connector materializations don't
   * pass through the inbox, so this is purely the local-file picture.
   */
  inboxHealthCounts(): {
    indexed: number;
    failed: number;
    skipped: number;
    pending: number;
    lastIndexedAt: string | null;
  } {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM inbox_items GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    const by = new Map(rows.map((r) => [r.status, r.n]));
    const lastIndexedAt =
      (
        this.db
          .prepare(
            "SELECT MAX(updated_at) AS t FROM inbox_items WHERE status IN ('done','indexed')",
          )
          .get() as { t: string | null }
      ).t ?? null;
    return {
      indexed: by.get("done") ?? 0,
      failed: by.get("failed") ?? 0,
      // "unsupported" files are the skipped bucket (a recognized non-error skip).
      skipped: by.get("unsupported") ?? 0,
      // Anything still mid-pipeline counts as pending/in-progress.
      pending:
        (by.get("queued") ?? 0) +
        (by.get("parsing") ?? 0) +
        (by.get("extracting") ?? 0) +
        (by.get("merging") ?? 0),
      lastIndexedAt,
    };
  }

  /**
   * The file extensions meOS encountered but does not index, with how many of each
   * (#87) — surfaced so the user knows what was left out. Derived from inbox items
   * marked `unsupported`, grouped by the extension parsed from their path/title.
   */
  inboxSkippedTypes(): Array<{ extension: string; count: number }> {
    const rows = this.db
      .prepare(`SELECT COALESCE(path, title) AS name FROM inbox_items WHERE status = 'unsupported'`)
      .all() as Array<{ name: string | null }>;
    const counts = new Map<string, number>();
    for (const r of rows) {
      const name = r.name ?? "";
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "(none)";
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([extension, count]) => ({ extension, count }))
      .sort((a, b) => b.count - a.count);
  }

  // --- durable ingest jobs (#13) ---------------------------------------

  /**
   * Persist a new ingestion unit in the `pending` state. The `payload` is a
   * small JSON pointer to the input (a file path or inbox item), never raw
   * buffers — the worker re-reads the source from disk so a crash mid-ingest
   * loses no data. Returns the new job id.
   */
  createIngestJob(input: {
    kind: string;
    queue?: IngestQueueKind;
    payload?: unknown;
    inboxItemId?: number;
    sourceId?: number;
    contentHash?: string | null;
    byteSize?: number | null;
    maxAttempts?: number;
    /** Work-type priority class (#18); defaults to the watched-file class. */
    priority?: number;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO ingest_jobs
           (kind, queue, payload, inbox_item_id, source_id, content_hash, byte_size,
            max_attempts, priority)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.queue ?? "extraction",
        input.payload === undefined ? null : JSON.stringify(input.payload),
        input.inboxItemId ?? null,
        input.sourceId ?? null,
        input.contentHash ?? null,
        input.byteSize ?? null,
        input.maxAttempts ?? 3,
        input.priority ?? IngestPriority.WATCH,
      );
    return Number(result.lastInsertRowid);
  }

  getIngestJob(id: number): IngestJobRow | undefined {
    return this.db.prepare("SELECT * FROM ingest_jobs WHERE id = ?").get(id) as
      | IngestJobRow
      | undefined;
  }

  listIngestJobs(limit = 100): IngestJobRow[] {
    return this.db
      .prepare("SELECT * FROM ingest_jobs ORDER BY updated_at DESC, id DESC LIMIT ?")
      .all(limit) as IngestJobRow[];
  }

  /**
   * Atomically claim the highest-priority runnable job on a queue: a `pending`
   * row whose backoff window (`run_after`) has elapsed, flipped to `processing`
   * and stamped `leased_at` so a crash leaves it recoverable. Opens an
   * `ingest_runs` row for this attempt. Returns the claimed job, or undefined if
   * none is ready. Ordering is (priority DESC, id ASC) so high-value work (a user
   * upload) drains ahead of a bulk import (#18) while staying strictly FIFO
   * within a priority class — deterministic and testable.
   */
  claimIngestJob(queue: IngestQueueKind): IngestJobRow | undefined {
    // Atomic claim: a single conditional UPDATE picks the next ready row and
    // flips it in one statement. The `AND state = 'pending'` in the UPDATE is the
    // load-bearing CAS guard — with two processes claiming concurrently, only the
    // one whose UPDATE matches the still-`pending` row wins; the loser's UPDATE
    // matches zero rows and RETURNING yields nothing. (The old SELECT-then-UPDATE
    // could double-claim across processes: both SELECTs saw the same row before
    // either UPDATE ran.) Run under IMMEDIATE so the write lock is taken up front.
    const claim = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `UPDATE ingest_jobs
           SET state = 'processing', attempts = attempts + 1, leased_at = datetime('now'),
               updated_at = datetime('now')
           WHERE id = (
             SELECT id FROM ingest_jobs
             WHERE queue = ? AND state = 'pending' AND run_after <= datetime('now')
             ORDER BY priority DESC, id ASC LIMIT 1
           )
             AND state = 'pending'
           RETURNING *`,
        )
        .get(queue) as IngestJobRow | undefined;
      if (!row) return undefined;
      this.db
        .prepare(
          `INSERT INTO ingest_runs (job_id, attempt, stage, state)
           VALUES (?, ?, ?, 'processing')`,
        )
        .run(row.id, row.attempts, row.stage);
      return row;
    });
    return claim.immediate();
  }

  /** Record progress through a stage (and reflect it on the active run row). */
  setIngestJobStage(id: number, stage: string): void {
    this.db
      .prepare("UPDATE ingest_jobs SET stage = ?, updated_at = datetime('now') WHERE id = ?")
      .run(stage, id);
  }

  /** Attach the resolved source + revision (#16) to a job once known. */
  setIngestJobSource(id: number, sourceId: number, sourceRevisionId?: number): void {
    this.db
      .prepare(
        `UPDATE ingest_jobs SET source_id = ?, source_revision_id = COALESCE(?, source_revision_id),
           updated_at = datetime('now') WHERE id = ?`,
      )
      .run(sourceId, sourceRevisionId ?? null, id);
  }

  /** Mark a job (and its open run) completed; clears the lease. */
  completeIngestJob(id: number, stage = "done"): void {
    const tx = this.db.transaction(() => {
      const job = this.getIngestJob(id);
      this.db
        .prepare(
          `UPDATE ingest_jobs
           SET state = 'completed', stage = ?, leased_at = NULL, last_error = NULL,
               updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(stage, id);
      this.finishRun(id, job?.attempts ?? 0, "completed");
    });
    tx();
  }

  /**
   * Record a stage failure. Below `max_attempts` the job returns to `pending`
   * with an exponential backoff window (`run_after`); at the cap it parks at
   * `dead-letter`. Returns the job's resulting state so the caller can log it.
   */
  failIngestJob(id: number, error: string, backoffBaseMs = 1000): IngestJobState {
    const tx = this.db.transaction(() => {
      const job = this.getIngestJob(id);
      if (!job) return "failed";
      const exhausted = job.attempts >= job.max_attempts;
      const nextState: IngestJobState = exhausted ? "dead-letter" : "pending";
      if (exhausted) {
        this.db
          .prepare(
            `UPDATE ingest_jobs
             SET state = 'dead-letter', leased_at = NULL, last_error = ?, updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(error, id);
        this.finishRun(id, job.attempts, "dead-letter", error);
      } else {
        // Exponential backoff in whole seconds (SQLite datetime granularity).
        const delaySec = Math.max(1, Math.round((backoffBaseMs * 2 ** (job.attempts - 1)) / 1000));
        this.db
          .prepare(
            `UPDATE ingest_jobs
             SET state = 'pending', leased_at = NULL, last_error = ?,
                 run_after = datetime('now', '+' || ? || ' seconds'), updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(error, delaySec, id);
        this.finishRun(id, job.attempts, "failed", error);
      }
      return nextState;
    });
    return tx();
  }

  /** Close the open `processing` run for a job's attempt with a terminal state. */
  private finishRun(
    jobId: number,
    attempt: number,
    state: "completed" | "failed" | "dead-letter",
    error?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE ingest_runs
         SET state = ?, error = COALESCE(?, error), finished_at = datetime('now')
         WHERE job_id = ? AND attempt = ? AND state = 'processing'`,
      )
      .run(state, error ?? null, jobId, attempt);
  }

  /**
   * Crash/restart recovery: any job stuck in `processing` (its worker died
   * before completing) is returned to `pending` so it runs again. Its open run
   * row is closed as failed. Idempotent stages make the re-run safe. Returns how
   * many jobs were recovered. `olderThanSeconds` guards against reclaiming a job
   * that is legitimately in flight right now (0 = reclaim all, used on startup).
   */
  recoverStaleIngestJobs(olderThanSeconds = 0): number {
    const tx = this.db.transaction(() => {
      const stale = this.db
        .prepare(
          `SELECT id, attempts FROM ingest_jobs
           WHERE state = 'processing'
             AND (leased_at IS NULL OR leased_at <= datetime('now', '-' || ? || ' seconds'))`,
        )
        .all(olderThanSeconds) as Array<{ id: number; attempts: number }>;
      for (const job of stale) {
        this.finishRun(job.id, job.attempts, "failed", "recovered from stale processing state");
        this.db
          .prepare(
            `UPDATE ingest_jobs
             SET state = 'pending', leased_at = NULL, updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(job.id);
      }
      return stale.length;
    });
    return tx();
  }

  /**
   * Requeue a `failed` or `dead-letter` job for a manual retry: reset attempts so
   * the bounded-retry budget starts fresh, clear the backoff, return to
   * `pending`. Returns false if the job is unknown or not in a retryable state.
   */
  retryIngestJob(id: number): boolean {
    const job = this.getIngestJob(id);
    if (!job || (job.state !== "failed" && job.state !== "dead-letter")) return false;
    this.db
      .prepare(
        `UPDATE ingest_jobs
         SET state = 'pending', attempts = 0, leased_at = NULL,
             run_after = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);
    return true;
  }

  /**
   * Bulk "retry all" for the dead-letter pile (#98): reset every exhausted job to
   * pending with a fresh attempt budget, runnable now. Returns how many were
   * requeued so the caller can wake the executor.
   */
  retryAllDeadLetterIngestJobs(): number {
    return this.db
      .prepare(
        `UPDATE ingest_jobs
         SET state = 'pending', attempts = 0, leased_at = NULL,
             run_after = datetime('now'), updated_at = datetime('now')
         WHERE state = 'dead-letter'`,
      )
      .run().changes;
  }

  /**
   * Discard the dead-letter pile (#98): the user has given up on these jobs.
   * Deletes them (their `ingest_runs` cascade, mirroring pruneCompletedIngestJobs)
   * and returns the deleted ids so the caller can drop any spilled staging bytes.
   */
  clearDeadLetterIngestJobs(): number[] {
    const rows = this.db
      .prepare(`DELETE FROM ingest_jobs WHERE state = 'dead-letter' RETURNING id`)
      .all() as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  /**
   * Cancel a single ingest job (#98): delete it unless it is actively
   * `processing` (which may be running in another process and can't be safely
   * interrupted mid-flight). Returns true if a job was removed.
   */
  cancelIngestJob(id: number): boolean {
    return (
      this.db.prepare(`DELETE FROM ingest_jobs WHERE id = ? AND state != 'processing'`).run(id)
        .changes > 0
    );
  }

  /** Whether ingest processing is paused (#98); persisted so it survives restart. */
  isIngestPaused(): boolean {
    return this.getSetting<boolean>("ingest_paused") ?? false;
  }

  /** Pause/resume ingest processing (#98). The executor checks this before admitting work. */
  setIngestPaused(paused: boolean): void {
    this.setSetting("ingest_paused", paused);
  }

  /**
   * The automatic provider hold, or null when not held. Set when ingest detects
   * the intelligence provider is unusable (out of credits, bad key, unknown
   * model); read by the executor (to stop admitting work) and the Health view
   * (to show one actionable banner). Persisted so it survives a restart.
   */
  getIngestHold(): IngestHold | null {
    return this.getSetting<IngestHold>("ingest_hold") ?? null;
  }

  /**
   * Engage the provider hold with a user-facing reason + classification. First
   * trip wins: if a hold is already in place we keep its original reason/since,
   * so a cascade of already-in-flight failures can't overwrite the first (most
   * relevant) message with a duplicate.
   */
  setIngestHold(reason: string, kind: string): void {
    if (this.getIngestHold()) return;
    this.setSetting("ingest_hold", { reason, kind, since: new Date().toISOString() });
  }

  /** Clear the provider hold (provider recovered, manual resume, or config change). */
  clearIngestHold(): void {
    this.setSetting("ingest_hold", null);
  }

  /**
   * Requeue a job that failed only because the provider was down: return it to
   * `pending` WITHOUT spending a retry attempt (undo the increment `claimIngestJob`
   * applied), so once the hold clears the job runs again with its full budget and
   * never wrongly dead-letters over an outage no retry could have fixed. Closes
   * the open run row for this attempt. Admission stays gated by the hold, so the
   * job won't actually re-run until the provider recovers.
   */
  holdIngestJob(id: number, error: string): void {
    const tx = this.db.transaction(() => {
      const job = this.getIngestJob(id);
      if (!job) return;
      this.finishRun(id, job.attempts, "failed", error);
      this.db
        .prepare(
          `UPDATE ingest_jobs
           SET state = 'pending', leased_at = NULL, last_error = ?,
               attempts = MAX(0, attempts - 1), run_after = datetime('now'),
               updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(error, id);
    });
    tx();
  }

  /** Per-queue depth + failure counts for the runtime health surface (#13/#18). */
  ingestQueueDepths(): IngestQueueDepth[] {
    const rows = this.db
      .prepare(
        `SELECT queue,
                SUM(state = 'pending')     AS pending,
                SUM(state = 'processing')  AS processing,
                SUM(state = 'failed')      AS failed,
                SUM(state = 'dead-letter') AS deadLetter
         FROM ingest_jobs GROUP BY queue`,
      )
      .all() as Array<{
      queue: IngestQueueKind;
      pending: number;
      processing: number;
      failed: number;
      deadLetter: number;
    }>;
    return rows.map((r) => ({
      queue: r.queue,
      pending: r.pending ?? 0,
      processing: r.processing ?? 0,
      failed: r.failed ?? 0,
      deadLetter: r.deadLetter ?? 0,
    }));
  }

  getIngestRuns(jobId: number): IngestRunRow[] {
    return this.db
      .prepare("SELECT * FROM ingest_runs WHERE job_id = ? ORDER BY attempt, id")
      .all(jobId) as IngestRunRow[];
  }

  // --- observability aggregates (#18) ----------------------------------

  /**
   * Extended per-queue metrics for the observability surface (#18): the depth
   * counters {@link ingestQueueDepths} reports, plus retrying/completed counts,
   * the mean duration of completed runs, and the age of the oldest queued job.
   * Read-only aggregate over `ingest_jobs` + `ingest_runs`.
   */
  ingestQueueMetrics(): IngestQueueMetrics[] {
    const jobRows = this.db
      .prepare(
        `SELECT queue,
                SUM(state = 'pending')                          AS pending,
                SUM(state = 'processing')                       AS processing,
                SUM(state = 'failed')                           AS failed,
                SUM(state = 'dead-letter')                      AS deadLetter,
                SUM(state = 'completed')                        AS completed,
                SUM(state = 'pending' AND attempts > 0)         AS retrying,
                MIN(CASE WHEN state = 'pending' THEN created_at END) AS oldestQueuedAt
         FROM ingest_jobs GROUP BY queue`,
      )
      .all() as Array<{
      queue: IngestQueueKind;
      pending: number | null;
      processing: number | null;
      failed: number | null;
      deadLetter: number | null;
      completed: number | null;
      retrying: number | null;
      oldestQueuedAt: string | null;
    }>;
    // Average completed-run duration per queue, joined via the run's owning job.
    const durRows = this.db
      .prepare(
        `SELECT j.queue AS queue,
                AVG(strftime('%s', r.finished_at) - strftime('%s', r.started_at)) AS avgSec
         FROM ingest_runs r JOIN ingest_jobs j ON j.id = r.job_id
         WHERE r.state = 'completed' AND r.finished_at IS NOT NULL
         GROUP BY j.queue`,
      )
      .all() as Array<{ queue: IngestQueueKind; avgSec: number | null }>;
    const avgByQueue = new Map(durRows.map((r) => [r.queue, r.avgSec ?? 0]));
    return jobRows.map((r) => ({
      queue: r.queue,
      pending: r.pending ?? 0,
      processing: r.processing ?? 0,
      failed: r.failed ?? 0,
      deadLetter: r.deadLetter ?? 0,
      completed: r.completed ?? 0,
      retrying: r.retrying ?? 0,
      avgDurationSeconds: Math.round((avgByQueue.get(r.queue) ?? 0) * 1000) / 1000,
      oldestQueuedAt: r.oldestQueuedAt ?? null,
    }));
  }

  /**
   * Per-stage timing + outcome counts from `ingest_runs` (#18) — the
   * parse/index/extract/merge breakdown the issue calls for. One row per stage,
   * with completed/failed/dead-letter/processing counts and mean+total finished
   * duration, so a slow or failure-prone stage is diagnosable from the UI.
   */
  ingestStageMetrics(): IngestStageMetric[] {
    const rows = this.db
      .prepare(
        `SELECT stage,
                SUM(state = 'completed')   AS completed,
                SUM(state = 'failed')      AS failed,
                SUM(state = 'dead-letter') AS deadLetter,
                SUM(state = 'processing')  AS processing,
                AVG(CASE WHEN finished_at IS NOT NULL
                         THEN strftime('%s', finished_at) - strftime('%s', started_at) END) AS avgSec,
                SUM(CASE WHEN finished_at IS NOT NULL
                         THEN strftime('%s', finished_at) - strftime('%s', started_at) ELSE 0 END) AS totalSec
         FROM ingest_runs GROUP BY stage ORDER BY stage`,
      )
      .all() as Array<{
      stage: string;
      completed: number | null;
      failed: number | null;
      deadLetter: number | null;
      processing: number | null;
      avgSec: number | null;
      totalSec: number | null;
    }>;
    return rows.map((r) => ({
      stage: r.stage,
      completed: r.completed ?? 0,
      failed: r.failed ?? 0,
      deadLetter: r.deadLetter ?? 0,
      processing: r.processing ?? 0,
      avgDurationSeconds: Math.round((r.avgSec ?? 0) * 1000) / 1000,
      totalDurationSeconds: r.totalSec ?? 0,
    }));
  }

  /**
   * Stale-job recovery counters (#18). Recovery closes the interrupted run with
   * a recognizable error ({@link recoverStaleIngestJobs}), so counting those rows
   * gives how many jobs were reclaimed from a crashed `processing` state;
   * dead-lettered is the live count of jobs that exhausted their retries.
   */
  ingestRecoveryMetrics(): IngestRecoveryMetrics {
    const recovered = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM ingest_runs
           WHERE state = 'failed' AND error = 'recovered from stale processing state'`,
        )
        .get() as { n: number }
    ).n;
    const deadLettered = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM ingest_jobs WHERE state = 'dead-letter'")
        .get() as { n: number }
    ).n;
    return { recovered, deadLettered };
  }

  /**
   * Per-extraction cost telemetry (#15/#18): groups the extraction cache by
   * (model, prompt version, strategy) and sums token usage, applying a best-
   * effort per-model USD rate when one is known. Token usage is plumbed-but-zero
   * upstream today, so this surfaces 0 cost until that lands — the shape is ready.
   */
  ingestCostMetrics(rateUsdPerKToken?: (modelId: string) => number | null): IngestCostMetric[] {
    const rows = this.db
      .prepare(
        `SELECT model_id AS modelId, prompt_version AS promptVersion, strategy,
                COUNT(*) AS extractions, COALESCE(SUM(token_usage), 0) AS tokenUsage
         FROM extraction_cache
         GROUP BY model_id, prompt_version, strategy
         ORDER BY model_id, prompt_version, strategy`,
      )
      .all() as Array<{
      modelId: string;
      promptVersion: string;
      strategy: ExtractionStrategy;
      extractions: number;
      tokenUsage: number;
    }>;
    return rows.map((r) => {
      const rate = rateUsdPerKToken?.(r.modelId) ?? null;
      return {
        modelId: r.modelId,
        promptVersion: r.promptVersion,
        strategy: r.strategy,
        extractions: r.extractions,
        tokenUsage: r.tokenUsage,
        estimatedCostUsd:
          rate === null ? null : Math.round((r.tokenUsage / 1000) * rate * 1e6) / 1e6,
      };
    });
  }

  /**
   * Retention sweep: delete `completed` jobs (and their cascade-linked runs)
   * older than the cutoff, keeping recent history for audit/debug. Failed and
   * dead-letter jobs are always retained so a stuck ingest stays diagnosable +
   * retryable. Returns how many jobs were pruned.
   */
  pruneCompletedIngestJobs(olderThanDays: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM ingest_jobs
         WHERE state = 'completed'
           AND updated_at < datetime('now', '-' || ? || ' days')`,
      )
      .run(olderThanDays);
    return result.changes;
  }

  // --- cross-process worker health (#94) ---

  /**
   * Upsert one worker's health snapshot, stamping the heartbeat to now. Called by
   * whichever process runs the worker (the forked worker host) so the app process
   * can surface its health without sharing memory.
   */
  upsertWorkerHealth(snapshot: WorkerHealthSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO worker_health (name, status, detail, last_error, last_run_at, queue_json, heartbeat_at)
         VALUES (@name, @status, @detail, @lastError, @lastRunAt, @queueJson, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET
           status = excluded.status, detail = excluded.detail, last_error = excluded.last_error,
           last_run_at = excluded.last_run_at, queue_json = excluded.queue_json,
           heartbeat_at = excluded.heartbeat_at`,
      )
      .run({
        name: snapshot.name,
        status: snapshot.status,
        detail: snapshot.detail ?? null,
        lastError: snapshot.lastError ?? null,
        lastRunAt: snapshot.lastRunAt ?? null,
        queueJson: snapshot.queue === undefined ? null : JSON.stringify(snapshot.queue),
      });
  }

  /** Read every persisted worker-health snapshot (see {@link upsertWorkerHealth}). */
  listWorkerHealth(): WorkerHealthRecord[] {
    const rows = this.db
      .prepare(
        `SELECT name, status, detail, last_error, last_run_at, queue_json, heartbeat_at
         FROM worker_health ORDER BY name`,
      )
      .all() as Array<{
      name: string;
      status: string;
      detail: string | null;
      last_error: string | null;
      last_run_at: string | null;
      queue_json: string | null;
      heartbeat_at: string;
    }>;
    return rows.map((r) => ({
      name: r.name,
      status: r.status,
      detail: r.detail,
      lastError: r.last_error,
      lastRunAt: r.last_run_at,
      queue: r.queue_json ? JSON.parse(r.queue_json) : undefined,
      heartbeatAt: r.heartbeat_at,
    }));
  }

  // --- entities ---

  findEntityByName(name: string): EntityRow | undefined {
    const normalized = name.trim();
    const byName = this.db
      .prepare("SELECT * FROM entities WHERE name = ? COLLATE NOCASE")
      .get(normalized) as EntityRow | undefined;
    if (byName) return byName;
    return this.db
      .prepare(
        `SELECT e.* FROM entities e
         JOIN entity_aliases a ON a.entity_id = e.id
         WHERE a.alias = ? COLLATE NOCASE`,
      )
      .get(normalized) as EntityRow | undefined;
  }

  createEntity(input: { type: EntityType; name: string; summary?: string }): EntityRow {
    let slug = slugify(input.name);
    let suffix = 2;
    while (this.getEntityBySlug(slug)) {
      slug = `${slugify(input.name)}-${suffix++}`;
    }
    const result = this.db
      .prepare("INSERT INTO entities (type, name, slug, summary) VALUES (?, ?, ?, ?)")
      .run(input.type, input.name.trim(), slug, input.summary ?? null);
    return this.getEntity(Number(result.lastInsertRowid))!;
  }

  getEntity(id: number): EntityRow | undefined {
    return this.db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as EntityRow | undefined;
  }

  getEntityBySlug(slug: string): EntityRow | undefined {
    return this.db.prepare("SELECT * FROM entities WHERE slug = ?").get(slug) as
      | EntityRow
      | undefined;
  }

  listEntities(): EntityRow[] {
    return this.db.prepare("SELECT * FROM entities ORDER BY type, name").all() as EntityRow[];
  }

  staleEntities(): EntityRow[] {
    return this.db.prepare("SELECT * FROM entities WHERE wiki_stale = 1").all() as EntityRow[];
  }

  /**
   * Merge a duplicate entity into a survivor (human-gated dedup). The loser's
   * observations, relationships, aliases, and history move to the winner; the
   * loser's name becomes an alias so future mentions resolve correctly; the
   * loser is deleted and the winner's page flagged for a rewrite. Transactional
   * and audited. Returns false when either id is unknown or they are the same.
   */
  mergeEntities(loserId: number, winnerId: number): boolean {
    if (loserId === winnerId) return false;
    const loser = this.getEntity(loserId);
    const winner = this.getEntity(winnerId);
    if (!loser || !winner) return false;

    const run = this.db.transaction(() => {
      // Names/aliases: the loser's name and aliases become the winner's aliases.
      this.db
        .prepare("INSERT OR IGNORE INTO entity_aliases (entity_id, alias) VALUES (?, ?)")
        .run(winnerId, loser.name);
      this.db
        .prepare("UPDATE OR IGNORE entity_aliases SET entity_id = ? WHERE entity_id = ?")
        .run(winnerId, loserId);
      this.db.prepare("DELETE FROM entity_aliases WHERE entity_id = ?").run(loserId);

      // Observations (and their sources via observation_id) move wholesale.
      this.db
        .prepare("UPDATE observations SET entity_id = ? WHERE entity_id = ?")
        .run(winnerId, loserId);

      // Relationships: re-point loser's edges to the winner, skipping the
      // self-edges and duplicates that would create (OR IGNORE drops those),
      // then delete whatever couldn't be re-pointed.
      this.db
        .prepare(
          "UPDATE OR IGNORE relationships SET from_entity = ? WHERE from_entity = ? AND to_entity <> ?",
        )
        .run(winnerId, loserId, winnerId);
      this.db
        .prepare(
          "UPDATE OR IGNORE relationships SET to_entity = ? WHERE to_entity = ? AND from_entity <> ?",
        )
        .run(winnerId, loserId, winnerId);
      this.db
        .prepare("DELETE FROM relationships WHERE from_entity = ? OR to_entity = ?")
        .run(loserId, loserId);

      // Wiki bookkeeping and history.
      this.db
        .prepare("UPDATE OR IGNORE wiki_stale_sources SET entity_id = ? WHERE entity_id = ?")
        .run(winnerId, loserId);
      this.db.prepare("DELETE FROM wiki_stale_sources WHERE entity_id = ?").run(loserId);
      this.db
        .prepare("UPDATE wiki_commit_changes SET entity_id = ? WHERE entity_id = ?")
        .run(winnerId, loserId);
      this.db.prepare("DELETE FROM wiki_pages WHERE entity_id = ?").run(loserId);

      this.db.prepare("DELETE FROM entities WHERE id = ?").run(loserId);
      this.db.prepare("UPDATE entities SET wiki_stale = 1 WHERE id = ?").run(winnerId);
      this.logAudit(
        "merge_entity",
        `"${loser.name}" (#${loserId}) merged into "${winner.name}" (#${winnerId})`,
      );
    });
    run();
    return true;
  }

  /**
   * Remember that the user rejected merging this pair, so duplicate detection
   * stops proposing it. Stored order-normalised (low id first) so a, b and b, a
   * are the same dismissal.
   */
  dismissDuplicate(aId: number, bId: number): boolean {
    if (aId === bId) return false;
    const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
    this.db
      .prepare("INSERT OR IGNORE INTO dismissed_duplicates (a_id, b_id) VALUES (?, ?)")
      .run(lo, hi);
    this.logAudit("dismiss_duplicate", `merge proposal for #${lo} ↔ #${hi} dismissed`);
    return true;
  }

  /** Order-normalised `${lo}-${hi}` keys of every pair the user has dismissed. */
  dismissedDuplicateKeys(): Set<string> {
    const rows = this.db.prepare("SELECT a_id, b_id FROM dismissed_duplicates").all() as Array<{
      a_id: number;
      b_id: number;
    }>;
    return new Set(rows.map((r) => `${r.a_id}-${r.b_id}`));
  }

  addAlias(entityId: number, alias: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO entity_aliases (entity_id, alias) VALUES (?, ?)")
      .run(entityId, alias.trim());
  }

  aliasesFor(entityId: number): string[] {
    return (
      this.db
        .prepare("SELECT alias FROM entity_aliases WHERE entity_id = ?")
        .all(entityId) as Array<{
        alias: string;
      }>
    ).map((row) => row.alias);
  }

  setEntitySummary(id: number, summary: string): void {
    this.db
      .prepare("UPDATE entities SET summary = ?, updated_at = datetime('now') WHERE id = ?")
      .run(summary, id);
  }

  /**
   * Flag an entity's page for regeneration. The flag only schedules a re-evaluation
   * — whether a page is actually written is decided later by the writer, which
   * skips entities that don't warrant one (see {@link entityWarrantsWikiPage}). So
   * an entity whose last fact just expired can still be flagged to update/blank its
   * existing page, while a connector-only entity flagged by the default
   * `wiki_stale = 1` is simply short-circuited at regeneration with no page written.
   * Returns true (kept for callers that record stale-source credit).
   */
  markWikiStale(id: number): boolean {
    this.db.prepare("UPDATE entities SET wiki_stale = 1 WHERE id = ?").run(id);
    return true;
  }

  // A wiki page is warranted only when an entity is *relevant* enough to hold its
  // own page — not merely named once. Being named by a single source keeps the
  // entity searchable (it stays a source), but a page is earned only when the
  // entity clears a relevance bar, so the wiki stays a map of what matters rather
  // than a page per passing mention. The bar (gate B) is met when ANY holds, over
  // wiki-eligible (or sourceless) backing only — connector content counts, but a
  // bare contact/calendar mention on its own does not:
  //   • recurrence    — named by ≥2 distinct sources, OR
  //   • connectedness — ≥2 active relationships, OR
  //   • richness      — ≥3 active, non-private facts.
  // A sub-threshold entity stays a searchable reference and graduates to a page
  // automatically the moment a second source names it, it gains a second link, or
  // it accrues a third fact. Tunable: the 2/2/3 constants below are the only knobs.
  private static readonly HAS_PAGE_WORTHY_SQL = `(
    (SELECT COUNT(DISTINCT o.source_id) FROM observations o LEFT JOIN sources s ON s.id = o.source_id
       WHERE o.entity_id = e.id AND o.status = 'active' AND o.sensitivity = 'normal'
         AND (o.source_id IS NULL OR s.wiki_eligible = 1)) >= 2
    OR (SELECT COUNT(*) FROM relationships r LEFT JOIN sources s ON s.id = r.source_id
         WHERE (r.from_entity = e.id OR r.to_entity = e.id) AND r.status = 'active'
           AND (r.source_id IS NULL OR s.wiki_eligible = 1)) >= 2
    OR (SELECT COUNT(*) FROM observations o LEFT JOIN sources s ON s.id = o.source_id
         WHERE o.entity_id = e.id AND o.status = 'active' AND o.sensitivity = 'normal'
           AND (o.source_id IS NULL OR s.wiki_eligible = 1)) >= 3
  )`;

  /**
   * A SQL predicate (on alias `e`) restricting entities to the user's enabled
   * types (#86). Returns "1" (no-op) when every type is enabled — the default —
   * so the all-enabled path is provably unchanged. The filter is applied only at
   * surfacing/promotion time; entities of disabled types stay in the DB and
   * become page-worthy again the moment their type is re-enabled.
   */
  private enabledTypePredicate(): string {
    const prefs = this.getKnowledgePreferences();
    const enabled = ENABLED_ENTITY_TYPES(prefs);
    if (enabled.length === ENTITY_TYPE_COUNT) return "1";
    if (enabled.length === 0) return "0";
    // Types come from a fixed enum, so inlining the quoted literals is safe.
    return `e.type IN (${enabled.map((t) => `'${t}'`).join(", ")})`;
  }

  /**
   * Does this entity warrant a standalone wiki page? True only when it has
   * page-worthy backing (see {@link HAS_PAGE_WORTHY_SQL}) AND its type is enabled
   * (#86). A person known only from a connector (contact/email/calendar) and a
   * "name only" contact with no facts both return false: they earn no page and
   * are hidden from the wiki index, while staying fully searchable.
   */
  entityWarrantsWikiPage(id: number): boolean {
    const row = this.db
      .prepare(
        `SELECT (${KnowledgeStore.HAS_PAGE_WORTHY_SQL} AND ${this.enabledTypePredicate()}) AS warrants
         FROM entities e WHERE e.id = ?`,
      )
      .get(id) as { warrants: number } | undefined;
    return row?.warrants === 1;
  }

  /**
   * The set of entity ids that warrant a wiki page (see
   * {@link entityWarrantsWikiPage}). Used to keep connector-only and factless
   * entities — and entities of disabled types (#86) — out of the wiki
   * index/graph and out of page synthesis.
   */
  wikiPageEntityIds(): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT e.id AS id FROM entities e
         WHERE ${KnowledgeStore.HAS_PAGE_WORTHY_SQL} AND ${this.enabledTypePredicate()}`,
      )
      .all() as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }

  clearWikiStale(id: number): void {
    this.db
      .prepare("UPDATE entities SET wiki_stale = 0, updated_at = datetime('now') WHERE id = ?")
      .run(id);
  }

  // --- wiki change tracking --------------------------------------------

  /** Note that `sourceId` is responsible for `entityId`'s page being stale. */
  recordStaleSource(entityId: number, sourceId: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO wiki_stale_sources (entity_id, source_id) VALUES (?, ?)")
      .run(entityId, sourceId);
  }

  /** Documents waiting to be credited with this entity's next regeneration. */
  pendingStaleSources(entityId: number): number[] {
    return (
      this.db
        .prepare("SELECT source_id FROM wiki_stale_sources WHERE entity_id = ?")
        .all(entityId) as Array<{ source_id: number }>
    ).map((row) => row.source_id);
  }

  clearStaleSources(entityId: number): void {
    this.db.prepare("DELETE FROM wiki_stale_sources WHERE entity_id = ?").run(entityId);
  }

  /**
   * Persist a regeneration pass's git commit and the per-file/source attribution
   * behind it, so a document can later be sliced back to just its own diff.
   */
  recordWikiCommit(hash: string, subject: string, changes: WikiChange[]): void {
    const insertCommit = this.db.prepare("INSERT INTO wiki_commits (hash, subject) VALUES (?, ?)");
    const insertChange = this.db.prepare(
      `INSERT INTO wiki_commit_changes (commit_id, entity_id, source_id, file_path, kind)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      const commitId = Number(insertCommit.run(hash, subject).lastInsertRowid);
      for (const change of changes) {
        const sources = change.sourceIds.length > 0 ? change.sourceIds : [null];
        for (const sourceId of sources) {
          insertChange.run(commitId, change.entityId, sourceId, change.filePath, change.kind);
        }
      }
    });
    tx();
  }

  /** Every recorded wiki change a document caused, newest commit first. */
  sourceChanges(sourceId: number): SourceChangeRow[] {
    return this.db
      .prepare(
        `SELECT wc.hash, wc.subject, wc.created_at AS committedAt,
                cc.file_path AS filePath, cc.kind,
                e.name AS entityName, e.slug AS entitySlug
         FROM wiki_commit_changes cc
         JOIN wiki_commits wc ON wc.id = cc.commit_id
         LEFT JOIN entities e ON e.id = cc.entity_id
         WHERE cc.source_id = ?
         ORDER BY wc.id DESC, cc.file_path`,
      )
      .all(sourceId) as SourceChangeRow[];
  }

  // --- wiki-maintainer runs (Activity transcripts) ---

  /** Open a run for a page regeneration; events are appended as the agent works. */
  createWikiRun(input: {
    entityId: number | null;
    name: string;
    type: string;
    slug: string | null;
    sourceIds: number[];
    author?: WikiRunAuthor;
  }): number {
    return Number(
      this.db
        .prepare(
          "INSERT INTO wiki_runs (entity_id, source_id, name, type, slug, author) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.entityId,
          input.sourceIds[0] ?? null,
          input.name,
          input.type,
          input.slug,
          input.author ?? "in-app",
        ).lastInsertRowid,
    );
  }

  /** Append one ordered transcript event to a run. */
  appendWikiRunEvent(
    runId: number,
    event: { seq: number; kind: WikiRunEventKind; toolName?: string | null; payload: string },
  ): void {
    this.db
      .prepare(
        "INSERT INTO wiki_run_events (run_id, seq, kind, tool_name, payload) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runId, event.seq, event.kind, event.toolName ?? null, event.payload);
  }

  /** Close a run, stamping its terminal status and finish time. */
  finishWikiRun(runId: number, status: "done" | "failed"): void {
    this.db
      .prepare("UPDATE wiki_runs SET status = ?, finished_at = datetime('now') WHERE id = ?")
      .run(status, runId);
  }

  /** The run feed, newest first. */
  listWikiRuns(limit = 100): WikiRunRow[] {
    return this.db
      .prepare("SELECT * FROM wiki_runs ORDER BY id DESC LIMIT ?")
      .all(limit) as WikiRunRow[];
  }

  getWikiRun(id: number): WikiRunRow | undefined {
    return this.db.prepare("SELECT * FROM wiki_runs WHERE id = ?").get(id) as
      | WikiRunRow
      | undefined;
  }

  /** A run's full transcript in order. */
  getWikiRunEvents(runId: number): WikiRunEventRow[] {
    return this.db
      .prepare("SELECT * FROM wiki_run_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as WikiRunEventRow[];
  }

  // --- relationships ---

  /**
   * Record a relationship from a source. A repeat from a *new* source raises the
   * edge's confidence (like an observation); the same source never inflates it.
   * Returns true only when the edge was newly created.
   */
  upsertRelationship(
    fromEntity: number,
    toEntity: number,
    label: string,
    sourceId?: number,
    sourceRevisionId?: number,
  ): boolean {
    const existing = this.db
      .prepare("SELECT id FROM relationships WHERE from_entity = ? AND to_entity = ? AND label = ?")
      .get(fromEntity, toEntity, label) as { id: number } | undefined;
    if (existing) {
      if (sourceId !== undefined) {
        const isNewSource =
          this.db
            .prepare(
              "INSERT OR IGNORE INTO relationship_sources (relationship_id, source_id) VALUES (?, ?)",
            )
            .run(existing.id, sourceId).changes > 0;
        if (isNewSource) {
          this.db
            .prepare(
              `UPDATE relationships SET confidence = MIN(${CONFIDENCE_CAP}, confidence + ${REINFORCE_STEP}) WHERE id = ?`,
            )
            .run(existing.id);
        }
      }
      // Re-confirmation by a current revision refreshes the edge's provenance.
      if (sourceRevisionId !== undefined) {
        this.db
          .prepare("UPDATE relationships SET source_revision_id = ? WHERE id = ?")
          .run(sourceRevisionId, existing.id);
      }
      return false;
    }
    const id = Number(
      this.db
        .prepare(
          "INSERT INTO relationships (from_entity, to_entity, label, source_id, source_revision_id) VALUES (?, ?, ?, ?, ?)",
        )
        .run(fromEntity, toEntity, label, sourceId ?? null, sourceRevisionId ?? null)
        .lastInsertRowid,
    );
    if (sourceId !== undefined) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO relationship_sources (relationship_id, source_id) VALUES (?, ?)",
        )
        .run(id, sourceId);
    }
    return true;
  }

  /** Active edges only, for the graph view. */
  allRelationships(): RelationshipView[] {
    return this.db
      .prepare(
        `SELECT r.id, r.label, r.from_entity, r.to_entity, r.confidence, r.status,
                ef.name AS from_name, et.name AS to_name
         FROM relationships r
         JOIN entities ef ON ef.id = r.from_entity
         JOIN entities et ON et.id = r.to_entity
         WHERE r.status = 'active'`,
      )
      .all() as RelationshipView[];
  }

  /**
   * Per-relationship provenance for the graph view (#89): a representative
   * source id (the edge's primary `source_id`, falling back to any joined
   * source) and how many distinct sources back it. Returned as a map keyed by
   * relationship id so the graph route can decorate edges in one query rather
   * than one lookup per edge.
   */
  relationshipSourceStats(): Map<number, { sourceId: number | null; sourceCount: number }> {
    const rows = this.db
      .prepare(
        `SELECT r.id AS relationship_id,
                r.source_id AS primary_source_id,
                COUNT(DISTINCT rs.source_id) AS source_count,
                MIN(rs.source_id) AS any_source_id
         FROM relationships r
         LEFT JOIN relationship_sources rs ON rs.relationship_id = r.id
         WHERE r.status = 'active'
         GROUP BY r.id`,
      )
      .all() as {
      relationship_id: number;
      primary_source_id: number | null;
      source_count: number;
      any_source_id: number | null;
    }[];
    const stats = new Map<number, { sourceId: number | null; sourceCount: number }>();
    for (const row of rows) {
      stats.set(row.relationship_id, {
        sourceId: row.primary_source_id ?? row.any_source_id,
        sourceCount: row.source_count,
      });
    }
    return stats;
  }

  relationshipsFor(entityId: number): RelationshipView[] {
    return this.db
      .prepare(
        `SELECT r.id, r.label, r.from_entity, r.to_entity, r.confidence, r.status,
                ef.name AS from_name, et.name AS to_name
         FROM relationships r
         JOIN entities ef ON ef.id = r.from_entity
         JOIN entities et ON et.id = r.to_entity
         WHERE (r.from_entity = ? OR r.to_entity = ?) AND r.status = 'active'`,
      )
      .all(entityId, entityId) as RelationshipView[];
  }

  /**
   * Graph traversal for downstream impact: entities one hop from any seed via an
   * active edge, ranked by how strongly/often they connect to the seed set.
   * Excludes the seeds themselves. This is the graph stream that retrieval fuses
   * alongside vector and keyword search.
   */
  graphNeighbors(seedIds: number[], limit = 10): number[] {
    if (seedIds.length === 0) return [];
    const placeholders = seedIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT neighbor, SUM(confidence) AS score FROM (
           SELECT to_entity AS neighbor, confidence FROM relationships
             WHERE status = 'active' AND from_entity IN (${placeholders})
           UNION ALL
           SELECT from_entity AS neighbor, confidence FROM relationships
             WHERE status = 'active' AND to_entity IN (${placeholders})
         )
         WHERE neighbor NOT IN (${placeholders})
         GROUP BY neighbor
         ORDER BY score DESC, neighbor
         LIMIT ?`,
      )
      .all(...seedIds, ...seedIds, ...seedIds, limit) as Array<{ neighbor: number }>;
    return rows.map((row) => row.neighbor);
  }

  /**
   * Breadth-first walk of the knowledge graph outward from one entity, following
   * active relationships up to `maxHops` and capped at `maxNodes`. Returns the
   * connected subgraph — the nodes actually reached and the labelled edges among
   * them — so a caller can both reason over the full neighbourhood and draw the
   * exact path it traversed. The seed is always included; edges are kept only
   * when both endpoints made the node cut, so the result is always renderable.
   */
  exploreSubgraph(seedId: number, maxHops = 2, maxNodes = 50): Subgraph {
    const seed = this.getEntity(seedId);
    if (!seed) return { nodes: [], edges: [] };
    const nodes = new Map<number, SubgraphNode>([[seed.id, toSubgraphNode(seed)]]);
    const edges: SubgraphEdge[] = [];
    const seenEdge = new Set<string>();
    const visited = new Set<number>([seedId]);
    let frontier = [seedId];

    for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const rel of this.relationshipsFor(id)) {
          const key = `${rel.from_entity}->${rel.to_entity}:${rel.label}`;
          if (!seenEdge.has(key)) {
            seenEdge.add(key);
            edges.push({ from: rel.from_entity, to: rel.to_entity, label: rel.label });
          }
          const otherId = rel.from_entity === id ? rel.to_entity : rel.from_entity;
          if (!visited.has(otherId) && nodes.size < maxNodes) {
            visited.add(otherId);
            const other = this.getEntity(otherId);
            if (other) {
              nodes.set(otherId, toSubgraphNode(other));
              next.push(otherId);
            }
          }
        }
      }
      frontier = next;
    }

    // Drop edges to nodes that fell outside the cap, so every edge is drawable.
    const keptEdges = edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));
    return { nodes: [...nodes.values()], edges: keptEdges };
  }

  // --- observations ---

  insertObservation(input: {
    entityId: number;
    text: string;
    sourceId?: number;
    embedding?: Float32Array;
    confidence?: number;
    kind?: string;
    sourceQuote?: string | null;
    charStart?: number | null;
    charEnd?: number | null;
    validFrom?: string | null;
    validUntil?: string | null;
    sensitivity?: "normal" | "private" | "secret";
    memoryTier?: "working" | "episodic" | "semantic" | "procedural";
    /** The exact source revision (#16) that produced this claim, for provenance/staleness. */
    sourceRevisionId?: number | null;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO observations
           (entity_id, text, source_id, confidence, embedding, kind, source_quote,
            char_start, char_end, valid_from, valid_until, sensitivity, memory_tier,
            source_revision_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.entityId,
        input.text,
        input.sourceId ?? null,
        input.confidence ?? 0.5,
        input.embedding ? serializeVector(input.embedding) : null,
        input.kind ?? "fact",
        input.sourceQuote ?? null,
        input.charStart ?? null,
        input.charEnd ?? null,
        input.validFrom ?? null,
        input.validUntil ?? null,
        input.sensitivity ?? "normal",
        input.memoryTier ?? "working",
        input.sourceRevisionId ?? null,
      );
    const id = Number(result.lastInsertRowid);
    if (input.sourceId !== undefined) this.recordObservationSource(id, input.sourceId);
    return id;
  }

  /** Record a document as backing an observation; true when it is a new source. */
  recordObservationSource(observationId: number, sourceId: number): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO observation_sources (observation_id, source_id) VALUES (?, ?)",
      )
      .run(observationId, sourceId);
    return result.changes > 0;
  }

  /** How many distinct documents corroborate an observation. */
  observationSourceCount(observationId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM observation_sources WHERE observation_id = ?")
      .get(observationId) as { n: number };
    return row.n;
  }

  activeObservations(entityId: number): ObservationRow[] {
    return this.db
      .prepare(
        `SELECT id, entity_id, text, source_id, tier, confidence, status, superseded_by,
                kind, source_quote, char_start, char_end, valid_from, valid_until, sensitivity,
                memory_tier, created_at, last_confirmed_at
         FROM observations WHERE entity_id = ? AND status = 'active'
         ORDER BY confidence DESC, last_confirmed_at DESC`,
      )
      .all(entityId) as ObservationRow[];
  }

  /**
   * Active observations safe to put in a portable artifact — the wiki, exported
   * briefs, lint. Two privacy boundaries are applied here, once, instead of at
   * every caller:
   *   - observation sensitivity: private/secret claims never leave memory;
   *   - source visibility: a claim whose backing source is not `wiki_eligible`
   *     (e.g. profile-context docs) is kept out of the compiled wiki page.
   */
  visibleObservations(entityId: number): ObservationRow[] {
    const blocked = this.sourceIdsWhere("wiki_eligible");
    return this.activeObservations(entityId).filter(
      (o) => o.sensitivity === "normal" && !(o.source_id !== null && blocked.has(o.source_id)),
    );
  }

  activeObservationVectors(entityId: number): Array<{ id: number; vector: Float32Array }> {
    const rows = this.db
      .prepare(
        "SELECT id, embedding FROM observations WHERE entity_id = ? AND status = 'active' AND embedding IS NOT NULL",
      )
      .all(entityId) as Array<{ id: number; embedding: Buffer }>;
    return rows.map((row) => ({ id: row.id, vector: deserializeVector(row.embedding) }));
  }

  getObservation(id: number): ObservationRow | undefined {
    return this.db
      .prepare(
        `SELECT id, entity_id, text, source_id, tier, confidence, status, superseded_by,
                kind, source_quote, char_start, char_end, valid_from, valid_until, sensitivity,
                memory_tier, created_at, last_confirmed_at
         FROM observations WHERE id = ?`,
      )
      .get(id) as ObservationRow | undefined;
  }

  // --- memory maintenance (Phase 2) ---

  /** New knowledge replaces old: the old observation is retired, never silently kept. */
  markSuperseded(oldId: number, newId: number): void {
    this.db
      .prepare("UPDATE observations SET status = 'superseded', superseded_by = ? WHERE id = ?")
      .run(newId, oldId);
  }

  /**
   * Reverse a supersession (governance: bulk/automated retirements must be
   * undoable). Reactivates the observation and clears its superseded_by. Returns
   * true when an observation was actually restored.
   */
  reverseSupersession(observationId: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE observations SET status = 'active', superseded_by = NULL WHERE id = ? AND status = 'superseded'",
      )
      .run(observationId);
    return result.changes > 0;
  }

  // --- audit trail (governance) ----------------------------------------

  /** Append a memory operation to the audit trail with a justification. */
  logAudit(op: string, detail?: string): void {
    this.db.prepare("INSERT INTO audit_log (op, detail) VALUES (?, ?)").run(op, detail ?? null);
  }

  /** The most recent audit entries, newest first. */
  recentAudit(
    limit = 100,
  ): Array<{ id: number; op: string; detail: string | null; created_at: string }> {
    return this.db
      .prepare("SELECT id, op, detail, created_at FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{ id: number; op: string; detail: string | null; created_at: string }>;
  }

  createContradiction(observationA: number, observationB: number, note?: string): number {
    const result = this.db
      .prepare("INSERT INTO contradictions (observation_a, observation_b, note) VALUES (?, ?, ?)")
      .run(observationA, observationB, note ?? null);
    return Number(result.lastInsertRowid);
  }

  unresolvedContradictions(): Array<{
    id: number;
    note: string | null;
    entity_name: string;
    text_a: string;
    text_b: string;
    created_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT c.id, c.note, c.created_at, e.name AS entity_name,
                oa.text AS text_a, ob.text AS text_b
         FROM contradictions c
         JOIN observations oa ON oa.id = c.observation_a
         JOIN observations ob ON ob.id = c.observation_b
         JOIN entities e ON e.id = oa.entity_id
         WHERE c.resolved = 0
         ORDER BY c.id DESC`,
      )
      .all() as Array<{
      id: number;
      note: string | null;
      entity_name: string;
      text_a: string;
      text_b: string;
      created_at: string;
    }>;
  }

  /** A contradiction with both sides' lifecycle signals, for proposing a resolution. */
  getContradiction(id: number):
    | {
        id: number;
        entity_id: number;
        observation_a: number;
        observation_b: number;
        note: string | null;
        resolved: number;
      }
    | undefined {
    return this.db
      .prepare(
        `SELECT c.id, c.note, c.resolved, c.observation_a, c.observation_b, oa.entity_id
         FROM contradictions c JOIN observations oa ON oa.id = c.observation_a
         WHERE c.id = ?`,
      )
      .get(id) as
      | {
          id: number;
          entity_id: number;
          observation_a: number;
          observation_b: number;
          note: string | null;
          resolved: number;
        }
      | undefined;
  }

  /**
   * Close a contradiction. Optionally retire one side (supersession) — the
   * accepted resolution. The entity's page is flagged so its prose updates.
   */
  resolveContradiction(id: number, supersede?: { loserId: number; winnerId: number }): void {
    const contradiction = this.getContradiction(id);
    if (!contradiction) return;
    const tx = this.db.transaction(() => {
      if (supersede) {
        this.db
          .prepare("UPDATE observations SET status = 'superseded', superseded_by = ? WHERE id = ?")
          .run(supersede.winnerId, supersede.loserId);
      }
      this.db.prepare("UPDATE contradictions SET resolved = 1 WHERE id = ?").run(id);
      this.markWikiStale(contradiction.entity_id);
    });
    tx();
  }

  /** Active claims of a given kind across all entities (e.g. every "decision"). */
  observationsByKind(kind: string): Array<{
    id: number;
    entity_id: number;
    entity_name: string;
    text: string;
    confidence: number;
    source_id: number | null;
    valid_from: string | null;
    created_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT o.id, o.entity_id, o.text, o.confidence, o.source_id, o.valid_from, o.created_at,
                e.name AS entity_name
         FROM observations o JOIN entities e ON e.id = o.entity_id
         WHERE o.status = 'active' AND o.kind = ? AND o.sensitivity = 'normal'
         ORDER BY COALESCE(o.valid_from, o.created_at) DESC`,
      )
      .all(kind) as Array<{
      id: number;
      entity_id: number;
      entity_name: string;
      text: string;
      confidence: number;
      source_id: number | null;
      valid_from: string | null;
      created_at: string;
    }>;
  }

  /** Observations corroborated past the threshold graduate to established facts. */
  promoteFacts(confidenceThreshold = 0.75): number {
    const result = this.db
      .prepare(
        "UPDATE observations SET tier = 'fact' WHERE tier = 'observation' AND status = 'active' AND confidence >= ?",
      )
      .run(confidenceThreshold);
    return result.changes;
  }

  /** Knowledge that hasn't been reinforced for a while is gradually deprioritised. */
  decayStaleConfidence(olderThanDays = 30, amount = 0.01, floor = 0.05): number {
    const result = this.db
      .prepare(
        `UPDATE observations
         SET confidence = MAX(?, confidence - ?)
         WHERE status = 'active' AND confidence > ?
           AND last_confirmed_at < datetime('now', '-' || ? || ' days')`,
      )
      .run(floor, amount, floor, olderThanDays);
    return result.changes;
  }

  /**
   * Kind-aware confidence decay (rohitg00's per-kind forgetting curve): each
   * kind ages on its own horizon — a task goes stale in weeks, a decision in a
   * year — instead of one flat cutoff for everything. Returns claims decayed.
   */
  decayStaleConfidenceByKind(
    horizons: Record<string, number>,
    defaultDays: number,
    amount = 0.01,
    floor = 0.05,
  ): number {
    const stmt = this.db.prepare(
      `UPDATE observations
         SET confidence = MAX(?, confidence - ?)
         WHERE status = 'active' AND confidence > ? AND kind = ?
           AND last_confirmed_at < datetime('now', '-' || ? || ' days')`,
    );
    const kinds = this.db
      .prepare("SELECT DISTINCT kind FROM observations WHERE status = 'active'")
      .all() as Array<{ kind: string }>;
    let changed = 0;
    const apply = this.db.transaction(() => {
      for (const { kind } of kinds) {
        const days = horizons[kind] ?? defaultDays;
        changed += stmt.run(floor, amount, floor, kind, days).changes;
      }
    });
    apply();
    return changed;
  }

  /**
   * Retire active claims whose stated validity window has passed (time-based
   * supersession). The pages they sat on are flagged stale so the prose updates.
   * `today` is an ISO date (YYYY-MM-DD). Returns how many expired.
   */
  expireObservationsByValidity(today: string): number {
    const entities = this.db
      .prepare(
        "SELECT DISTINCT entity_id FROM observations WHERE status = 'active' AND valid_until IS NOT NULL AND valid_until < ?",
      )
      .all(today) as Array<{ entity_id: number }>;
    const result = this.db
      .prepare(
        "UPDATE observations SET status = 'superseded' WHERE status = 'active' AND valid_until IS NOT NULL AND valid_until < ?",
      )
      .run(today);
    for (const { entity_id } of entities) this.markWikiStale(entity_id);
    return result.changes;
  }

  setMemoryTier(id: number, tier: "working" | "episodic" | "semantic" | "procedural"): void {
    this.db.prepare("UPDATE observations SET memory_tier = ? WHERE id = ?").run(tier, id);
  }

  /** Per active claim: its kind, source type, and distinct source count — drives tier reclassification. */
  observationTierInputs(): Array<{
    id: number;
    kind: string;
    source_type: string | null;
    source_count: number;
    memory_tier: string;
  }> {
    return this.db
      .prepare(
        `SELECT o.id, o.kind, o.memory_tier, s.type AS source_type,
                (SELECT COUNT(*) FROM observation_sources os WHERE os.observation_id = o.id) AS source_count
         FROM observations o LEFT JOIN sources s ON s.id = o.source_id
         WHERE o.status = 'active'`,
      )
      .all() as Array<{
      id: number;
      kind: string;
      source_type: string | null;
      source_count: number;
      memory_tier: string;
    }>;
  }

  /** Wiki pages with no connections to the rest of the graph, surfaced for review. */
  /**
   * Entities with no relationships (digest "possible orphans"). When `focus` is
   * given (#86), only entities of an enabled type are returned — non-destructive
   * surfacing filter; omit it for the unchanged pre-#86 behaviour.
   */
  orphanEntities(focus?: KnowledgePreferences): EntityRow[] {
    const types = focus ? [...enabledEntityTypes(focus)] : null;
    const typeFilter =
      types && types.length < ENTITY_TYPE_COUNT
        ? ` AND e.type IN (${types.length ? types.map((t) => `'${t}'`).join(", ") : "''"})`
        : "";
    return this.db
      .prepare(
        `SELECT * FROM entities e
         WHERE NOT EXISTS (
           SELECT 1 FROM relationships r WHERE r.from_entity = e.id OR r.to_entity = e.id
         )${typeFilter}
         ORDER BY e.name`,
      )
      .all() as EntityRow[];
  }

  /**
   * Sources created since a cutoff. By default the raw list (used internally,
   * e.g. to gather profile-context docs the assistant drafts from). Pass a scope
   * to honour the source-visibility model where the result is surfaced to the
   * user or exported:
   *   - "export"   keeps only `exportable` sources (the daily digest);
   *   - "activity" keeps only `activity_visible` sources (the recent-sources feed).
   */
  recentSources(
    sinceIso: string,
    scope?: "export" | "activity",
  ): Array<{ id: number; title: string; type: string; created_at: string }> {
    const flag =
      scope === "export"
        ? " AND exportable = 1"
        : scope === "activity"
          ? " AND activity_visible = 1"
          : "";
    return this.db
      .prepare(
        `SELECT id, title, type, created_at FROM sources WHERE created_at >= ?${flag} ORDER BY id DESC`,
      )
      .all(sinceIso) as Array<{ id: number; title: string; type: string; created_at: string }>;
  }

  /**
   * Active observations created since a cutoff (digest "new knowledge"). When
   * `focus` is given (#86), only observations whose entity type AND kind are both
   * enabled are returned — a non-destructive surfacing filter. Omit `focus` (or
   * pass the all-enabled default) for the unchanged pre-#86 behaviour.
   */
  recentObservations(
    sinceIso: string,
    focus?: KnowledgePreferences,
  ): Array<{ text: string; entity_name: string; confidence: number }> {
    const filter = this.observationFocusSql(focus);
    return this.db
      .prepare(
        `SELECT o.text, o.confidence, e.name AS entity_name
         FROM observations o JOIN entities e ON e.id = o.entity_id
         WHERE o.created_at >= ? AND o.status = 'active'${filter}
         ORDER BY o.id DESC LIMIT 100`,
      )
      .all(sinceIso) as Array<{ text: string; entity_name: string; confidence: number }>;
  }

  /**
   * A SQL predicate (aliases `e` for entity, `o` for observation) restricting to
   * enabled entity types and observation kinds (#86). Returns "" (no-op) when
   * preferences are unrestricted, so the default path is unchanged.
   */
  private observationFocusSql(focus?: KnowledgePreferences): string {
    if (!focus) return "";
    const types = [...enabledEntityTypes(focus)];
    const kinds = [...enabledObservationKinds(focus)];
    const clauses: string[] = [];
    if (types.length < ENTITY_TYPE_COUNT) {
      clauses.push(types.length ? `e.type IN (${types.map((t) => `'${t}'`).join(", ")})` : "0");
    }
    if (kinds.length < OBSERVATION_KIND_COUNT) {
      clauses.push(kinds.length ? `o.kind IN (${kinds.map((k) => `'${k}'`).join(", ")})` : "0");
    }
    return clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
  }

  recentlySuperseded(
    sinceIso: string,
  ): Array<{ old_text: string; new_text: string; entity_name: string }> {
    return this.db
      .prepare(
        `SELECT old.text AS old_text, new.text AS new_text, e.name AS entity_name
         FROM observations old
         JOIN observations new ON new.id = old.superseded_by
         JOIN entities e ON e.id = old.entity_id
         WHERE old.status = 'superseded' AND new.created_at >= ?`,
      )
      .all(sinceIso) as Array<{ old_text: string; new_text: string; entity_name: string }>;
  }

  saveDigest(date: string, content: string): void {
    this.db
      .prepare(
        `INSERT INTO digests (date, content) VALUES (?, ?)
         ON CONFLICT(date) DO UPDATE SET content = excluded.content`,
      )
      .run(date, content);
  }

  latestDigest(): { date: string; content: string } | undefined {
    return this.db.prepare("SELECT date, content FROM digests ORDER BY date DESC LIMIT 1").get() as
      | { date: string; content: string }
      | undefined;
  }

  // --- conversations ---

  createConversation(title?: string): number {
    const result = this.db
      .prepare("INSERT INTO conversations (title) VALUES (?)")
      .run(title ?? null);
    return Number(result.lastInsertRowid);
  }

  /** Conversations ordered by most recent activity (last message, else creation). */
  listConversations(): Array<{ id: number; title: string | null; created_at: string }> {
    return this.db
      .prepare(
        `SELECT c.id, c.title, c.created_at FROM conversations c
         ORDER BY COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.conversation_id = c.id), 0) DESC, c.id DESC`,
      )
      .all() as Array<{ id: number; title: string | null; created_at: string }>;
  }

  setConversationTitle(id: number, title: string): void {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
  }

  conversationExists(id: number): boolean {
    return this.db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id) !== undefined;
  }

  addMessage(conversationId: number, role: "user" | "assistant", content: string): number {
    const result = this.db
      .prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)")
      .run(conversationId, role, content);
    return Number(result.lastInsertRowid);
  }

  /**
   * Persist a coding-agent turn's run metadata (its trace, telemetry, and the
   * files it touched) so reopening the conversation rebuilds the IDE-style timeline
   * — not just the final answer. One row per agent message; the plain knowledge
   * chat never calls this. `trace`/`filesChanged` are stored as JSON; telemetry as
   * plain columns. Skips writing entirely when there's genuinely nothing to keep.
   */
  saveMessageAgentMeta(messageId: number, meta: MessageAgentMeta): void {
    const hasTrace = meta.trace !== undefined && meta.trace.length > 0;
    const hasFiles = meta.filesChanged !== undefined && meta.filesChanged.length > 0;
    if (!hasTrace && !hasFiles && !meta.telemetry) return;
    this.db
      .prepare(
        `INSERT INTO message_agent_meta (message_id, trace, cost_usd, num_turns, duration_ms, files_changed)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           trace = excluded.trace, cost_usd = excluded.cost_usd, num_turns = excluded.num_turns,
           duration_ms = excluded.duration_ms, files_changed = excluded.files_changed`,
      )
      .run(
        messageId,
        hasTrace ? JSON.stringify(meta.trace) : null,
        meta.telemetry?.costUsd ?? null,
        meta.telemetry?.numTurns ?? null,
        meta.telemetry?.durationMs ?? null,
        hasFiles ? JSON.stringify(meta.filesChanged) : null,
      );
  }

  /** Record which documents an assistant reply drew on. */
  linkMessageSources(messageId: number, sourceIds: number[]): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO message_sources (message_id, source_id) VALUES (?, ?)",
    );
    const insertAll = this.db.transaction(() => {
      for (const sourceId of sourceIds) insert.run(messageId, sourceId);
    });
    insertAll();
  }

  listMessages(conversationId: number): Array<{
    id: number;
    role: "user" | "assistant";
    content: string;
    created_at: string;
    sources: SourceRef[];
    trace?: AgentTracePart[];
    telemetry?: { costUsd: number; numTurns: number; durationMs: number };
    filesChanged?: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
  }> {
    const messages = this.db
      .prepare(
        "SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id",
      )
      .all(conversationId) as Array<{
      id: number;
      role: "user" | "assistant";
      content: string;
      created_at: string;
    }>;
    const refs = this.db
      .prepare(
        `SELECT ms.message_id, s.id, s.title, s.path
         FROM message_sources ms
         JOIN sources s ON s.id = ms.source_id
         JOIN messages m ON m.id = ms.message_id
         WHERE m.conversation_id = ?
         ORDER BY s.title`,
      )
      .all(conversationId) as Array<SourceRef & { message_id: number }>;
    const byMessage = new Map<number, SourceRef[]>();
    for (const { message_id, ...source } of refs) {
      const list = byMessage.get(message_id) ?? [];
      list.push(source);
      byMessage.set(message_id, list);
    }
    // Coding-agent turns also carry persisted run metadata (trace/telemetry/files)
    // — joined here so a reload rebuilds the timeline, not just the answer text.
    const metaRows = this.db
      .prepare(
        `SELECT mam.message_id, mam.trace, mam.cost_usd, mam.num_turns, mam.duration_ms, mam.files_changed
         FROM message_agent_meta mam
         JOIN messages m ON m.id = mam.message_id
         WHERE m.conversation_id = ?`,
      )
      .all(conversationId) as Array<{
      message_id: number;
      trace: string | null;
      cost_usd: number | null;
      num_turns: number | null;
      duration_ms: number | null;
      files_changed: string | null;
    }>;
    const metaByMessage = new Map<number, MessageAgentMeta>();
    for (const row of metaRows) {
      const meta: MessageAgentMeta = {};
      if (row.trace) meta.trace = safeParseJson<AgentTracePart[]>(row.trace);
      if (row.files_changed) {
        meta.filesChanged =
          safeParseJson<MessageAgentMeta["filesChanged"]>(row.files_changed) ?? undefined;
      }
      if (row.num_turns !== null || row.duration_ms !== null || row.cost_usd !== null) {
        meta.telemetry = {
          costUsd: row.cost_usd ?? 0,
          numTurns: row.num_turns ?? 0,
          durationMs: row.duration_ms ?? 0,
        };
      }
      metaByMessage.set(row.message_id, meta);
    }
    return messages.map((message) => {
      const meta = metaByMessage.get(message.id);
      return {
        ...message,
        sources: byMessage.get(message.id) ?? [],
        ...(meta?.trace ? { trace: meta.trace } : {}),
        ...(meta?.telemetry ? { telemetry: meta.telemetry } : {}),
        ...(meta?.filesChanged ? { filesChanged: meta.filesChanged } : {}),
      };
    });
  }

  /** What the user typed in chat since a cutoff — raw material for crystallization. */
  recentUserMessages(sinceIso: string): Array<{ content: string; created_at: string }> {
    return this.db
      .prepare(
        // Exclude slash commands (e.g. /profile) — they are directives to the
        // app, not statements about the user's world worth crystallizing.
        `SELECT content, created_at FROM messages
         WHERE role = 'user' AND created_at >= ? AND content NOT LIKE '/%' ORDER BY id`,
      )
      .all(sinceIso) as Array<{ content: string; created_at: string }>;
  }

  /**
   * A new document restating an existing fact corroborates it: confidence rises
   * (capped) only when the source is genuinely new, so re-reading the same
   * document never inflates it — confidence tracks *source count*, not mentions.
   * Re-confirmation always refreshes recency so the fact resists decay.
   */
  reinforceObservation(id: number, sourceId?: number, sourceRevisionId?: number): void {
    const distinctSource =
      sourceId === undefined ? true : this.recordObservationSource(id, sourceId);
    this.db
      .prepare(
        distinctSource
          ? `UPDATE observations
             SET confidence = MIN(${CONFIDENCE_CAP}, confidence + ${REINFORCE_STEP}), last_confirmed_at = datetime('now')
             WHERE id = ?`
          : "UPDATE observations SET last_confirmed_at = datetime('now') WHERE id = ?",
      )
      .run(id);
    // A re-confirmation by a current revision refreshes the claim's provenance to
    // that revision, so a fact that survives a re-ingest is no longer flagged as
    // backed by the now-superseded prior version.
    if (sourceRevisionId !== undefined) {
      this.db
        .prepare("UPDATE observations SET source_revision_id = ? WHERE id = ?")
        .run(sourceRevisionId, id);
    }
  }

  // --- compiled wiki pages (retrievable prose) -------------------------

  /**
   * Persist the body the writer produced so chat can retrieve compiled prose.
   * Also records `body_hash` (so an unchanged page is skipped on the next pass by
   * either maintenance path) and `authored_by` (so the in-app refresh paths don't
   * clobber a page the user maintains with their own coding agent).
   */
  upsertWikiPage(
    entityId: number,
    body: string,
    embedding?: Float32Array,
    authoredBy: WikiAuthor = "in-app",
  ): void {
    const bodyHash = createHash("sha256").update(body).digest("hex");
    this.db
      .prepare(
        `INSERT INTO wiki_pages (entity_id, body, embedding, body_hash, authored_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET body = excluded.body,
           embedding = excluded.embedding, body_hash = excluded.body_hash,
           authored_by = excluded.authored_by, updated_at = datetime('now')`,
      )
      .run(entityId, body, embedding ? serializeVector(embedding) : null, bodyHash, authoredBy);
  }

  /** Drop an entity's compiled page from the retrieval table (e.g. it no longer
   *  warrants a page). The on-disk Markdown is removed separately by the writer. */
  deleteWikiPage(entityId: number): void {
    this.db.prepare("DELETE FROM wiki_pages WHERE entity_id = ?").run(entityId);
  }

  /** Every entity's [[wiki-link]] mentions, for broken-reference detection. */
  wikiPageBodies(): WikiPageBody[] {
    return this.db
      .prepare(
        `SELECT w.entity_id, w.body, e.name AS entity_name, e.slug, e.type
         FROM wiki_pages w JOIN entities e ON e.id = w.entity_id`,
      )
      .all() as WikiPageBody[];
  }

  /** One entity's compiled wiki page body, if it has one. */
  wikiPageBody(entityId: number): WikiPageBody | undefined {
    return this.db
      .prepare(
        `SELECT w.entity_id, w.body, e.name AS entity_name, e.slug, e.type
         FROM wiki_pages w JOIN entities e ON e.id = w.entity_id
         WHERE w.entity_id = ?`,
      )
      .get(entityId) as WikiPageBody | undefined;
  }

  /** One entity's compiled page with the maintenance-ledger columns (hash,
   *  author, quality), if it has a page. Backs the external-maintenance endpoints
   *  and the idempotent commit skip (on-disk body hash vs stored body_hash). */
  wikiPageMeta(entityId: number): WikiPageMeta | undefined {
    return this.db
      .prepare(
        `SELECT entity_id, body, body_hash, authored_by, quality, updated_at
         FROM wiki_pages WHERE entity_id = ?`,
      )
      .get(entityId) as WikiPageMeta | undefined;
  }

  /** Persist a page's lint score (0..1). */
  setWikiQuality(entityId: number, quality: number): void {
    this.db.prepare("UPDATE wiki_pages SET quality = ? WHERE entity_id = ?").run(quality, entityId);
  }

  /** Pages below a quality threshold, worst first — surfaced for review. */
  lowQualityPages(
    threshold = 0.6,
  ): Array<{ entity_id: number; entity_name: string; quality: number }> {
    return this.db
      .prepare(
        `SELECT w.entity_id, w.quality, e.name AS entity_name
         FROM wiki_pages w JOIN entities e ON e.id = w.entity_id
         WHERE w.quality IS NOT NULL AND w.quality < ?
         ORDER BY w.quality ASC`,
      )
      .all(threshold) as Array<{ entity_id: number; entity_name: string; quality: number }>;
  }

  // --- hybrid retrieval -------------------------------------------------

  /** All active observations carrying an embedding, with owning-entity context. */
  allActiveObservationVectors(): ObservationWithVector[] {
    const rows = this.db
      .prepare(
        `SELECT o.id, o.entity_id, o.text, o.confidence, o.source_id, o.embedding,
                e.name AS entity_name, e.type AS entity_type
         FROM observations o JOIN entities e ON e.id = o.entity_id
         WHERE o.status = 'active' AND o.embedding IS NOT NULL`,
      )
      .all() as Array<{
      id: number;
      entity_id: number;
      text: string;
      confidence: number;
      source_id: number | null;
      embedding: Buffer;
      entity_name: string;
      entity_type: EntityType;
    }>;
    return rows.map((row) => ({
      id: row.id,
      entity_id: row.entity_id,
      entity_name: row.entity_name,
      entity_type: row.entity_type,
      text: row.text,
      confidence: row.confidence,
      source_id: row.source_id,
      vector: deserializeVector(row.embedding),
    }));
  }

  /** All persisted wiki pages with embeddings, with owning-entity context. */
  allWikiPageVectors(): WikiPageWithVector[] {
    const rows = this.db
      .prepare(
        `SELECT w.entity_id, w.body, w.embedding, e.name AS entity_name, e.type AS entity_type, e.slug
         FROM wiki_pages w JOIN entities e ON e.id = w.entity_id
         WHERE w.embedding IS NOT NULL`,
      )
      .all() as Array<{
      entity_id: number;
      body: string;
      embedding: Buffer;
      entity_name: string;
      entity_type: EntityType;
      slug: string;
    }>;
    return rows.map((row) => ({
      entity_id: row.entity_id,
      entity_name: row.entity_name,
      entity_type: row.entity_type,
      slug: row.slug,
      body: row.body,
      vector: deserializeVector(row.embedding),
    }));
  }

  /**
   * BM25 keyword search over a full-text index. Returns rowids best-first.
   * The query is tokenised to a safe OR of terms so arbitrary user text can
   * never trip FTS5's query syntax.
   */
  private ftsSearch(table: string, query: string, limit: number): number[] {
    const terms = query
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((t) => t.length > 1);
    if (!terms || terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"`).join(" OR ");
    const rows = this.db
      .prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`)
      .all(match, limit) as Array<{ rowid: number }>;
    return rows.map((row) => row.rowid);
  }

  chunkFtsSearch(query: string, limit = 20): number[] {
    return this.ftsSearch("chunks_fts", query, limit);
  }

  observationFtsSearch(query: string, limit = 20): number[] {
    return this.ftsSearch("observations_fts", query, limit);
  }

  wikiFtsSearch(query: string, limit = 20): number[] {
    return this.ftsSearch("wiki_fts", query, limit);
  }

  // --- app settings ----------------------------------------------------

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(key, JSON.stringify(value));
  }

  /**
   * The wiki maintenance mode. Defaults to `in-app` (unchanged behavior) until
   * the user opts into external (coding-agent) maintenance. Only the in-app
   * auto-rewrite consults this; the external endpoints work in any mode.
   */
  getWikiMaintenanceMode(): WikiMaintenanceMode {
    const mode = this.getSetting<WikiMaintenanceMode>("wiki_maintenance");
    return mode === "external" || mode === "hybrid" ? mode : "in-app";
  }

  setWikiMaintenanceMode(mode: WikiMaintenanceMode): void {
    this.setSetting("wiki_maintenance", mode);
  }

  // --- knowledge preferences (#86) -------------------------------------
  // Which entity types / observation kinds the user wants MeOS to focus on.
  // Stored as one JSON blob in `settings`; unset == the all-enabled default, so
  // a fresh DB behaves exactly as before #86. Reads/writes never touch
  // entities/observations — disabling a type only narrows surfacing.

  /** The resolved preferences, defaulting to all-enabled when unset. */
  getKnowledgePreferences(): KnowledgePreferences {
    return resolvePreferences(
      this.getSetting<Partial<KnowledgePreferences>>(KNOWLEDGE_PREFERENCES_KEY),
    );
  }

  /** Persist preferences (resolved/normalised first). Non-destructive. */
  setKnowledgePreferences(prefs: Partial<KnowledgePreferences>): KnowledgePreferences {
    const resolved = resolvePreferences(prefs);
    this.setSetting(KNOWLEDGE_PREFERENCES_KEY, resolved);
    return resolved;
  }

  // --- watched folders -------------------------------------------------

  listWatchedFolders(): Array<{ id: number; path: string; created_at: string }> {
    return this.db
      .prepare("SELECT id, path, created_at FROM watched_folders ORDER BY path")
      .all() as Array<{ id: number; path: string; created_at: string }>;
  }

  addWatchedFolder(folderPath: string): { id: number; path: string } {
    this.db.prepare("INSERT OR IGNORE INTO watched_folders (path) VALUES (?)").run(folderPath);
    return this.db
      .prepare("SELECT id, path FROM watched_folders WHERE path = ?")
      .get(folderPath) as { id: number; path: string };
  }

  /** Returns the removed folder's path, or undefined when the id is unknown. */
  removeWatchedFolder(id: number): string | undefined {
    const row = this.db.prepare("SELECT path FROM watched_folders WHERE id = ?").get(id) as
      | { path: string }
      | undefined;
    if (!row) return undefined;
    this.db.prepare("DELETE FROM watched_folders WHERE id = ?").run(id);
    return row.path;
  }

  /**
   * Cheap pre-filter: true unless this exact (path + mtime + size) was absorbed
   * before. Stat-only, so unchanged files cost no I/O. A "true" here only means
   * "maybe changed" — the content hash confirms whether the bytes truly differ.
   */
  fileNeedsIngest(filePath: string, mtimeMs: number, size: number): boolean {
    const row = this.db
      .prepare("SELECT mtime_ms, size FROM ingested_files WHERE path = ?")
      .get(filePath) as { mtime_ms: number; size: number } | undefined;
    return !row || row.mtime_ms !== Math.floor(mtimeMs) || row.size !== size;
  }

  /**
   * True when we've already absorbed exactly these bytes for this path — i.e.
   * the mtime/size shifted but the content hash matches, so the change was
   * cosmetic (re-download, restore, touch) and there's nothing new to ingest.
   * False for a first sighting or a legacy row with no recorded hash.
   */
  fileContentUnchanged(filePath: string, contentHash: string): boolean {
    const row = this.db
      .prepare("SELECT content_hash FROM ingested_files WHERE path = ?")
      .get(filePath) as { content_hash: string | null } | undefined;
    return row?.content_hash != null && row.content_hash === contentHash;
  }

  recordIngestedFile(filePath: string, mtimeMs: number, size: number, contentHash?: string): void {
    this.db
      .prepare(
        `INSERT INTO ingested_files (path, mtime_ms, size, content_hash) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size,
           content_hash = excluded.content_hash, ingested_at = datetime('now')`,
      )
      .run(filePath, Math.floor(mtimeMs), size, contentHash ?? null);
  }

  // --- external connectors (Google Contacts/Calendar/Gmail) ------------

  upsertConnectorAccount(input: {
    provider: string;
    accountEmail?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
    expiry?: string | null;
    scopes?: string | null;
    clientId?: string | null;
    clientSecret?: string | null;
    /**
     * Basic-auth credentials as a JSON object string (host/username/password …).
     * COALESCE-merged like the OAuth secrets, and treated as a connect signal:
     * an account with auth_config set reads as connected even with no token.
     */
    authConfig?: string | null;
  }): number {
    // Update only the columns provided so re-saving credentials never clobbers
    // tokens (and re-connecting never clobbers stored credentials).
    this.db
      .prepare(
        `INSERT INTO connector_accounts
           (provider, account_email, access_token, refresh_token, expiry, scopes, client_id, client_secret, auth_config, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected')
         ON CONFLICT(provider) DO UPDATE SET
           account_email = COALESCE(excluded.account_email, account_email),
           access_token  = COALESCE(excluded.access_token, access_token),
           refresh_token = COALESCE(excluded.refresh_token, refresh_token),
           expiry        = COALESCE(excluded.expiry, expiry),
           scopes        = COALESCE(excluded.scopes, scopes),
           client_id     = COALESCE(excluded.client_id, client_id),
           client_secret = COALESCE(excluded.client_secret, client_secret),
           auth_config   = COALESCE(excluded.auth_config, auth_config),
           status        = CASE
             WHEN excluded.access_token IS NOT NULL OR excluded.auth_config IS NOT NULL
             THEN 'connected' ELSE status END`,
      )
      .run(
        input.provider,
        input.accountEmail ?? null,
        input.accessToken ?? null,
        input.refreshToken ?? null,
        input.expiry ?? null,
        input.scopes ?? null,
        input.clientId ?? null,
        input.clientSecret ?? null,
        input.authConfig ?? null,
      );
    return (this.getConnectorAccount(input.provider) as ConnectorAccountRow).id;
  }

  getConnectorAccount(provider: string): ConnectorAccountRow | undefined {
    return this.db
      .prepare(
        `SELECT id, provider, account_email, access_token, refresh_token, expiry, scopes,
                client_id, client_secret, auth_config, status, created_at
         FROM connector_accounts WHERE provider = ?`,
      )
      .get(provider) as ConnectorAccountRow | undefined;
  }

  /**
   * The parsed basic-auth credentials for a provider (host/username/password …),
   * or undefined when the account has none (an OAuth account, or no account). The
   * inverse of {@link upsertConnectorAccount}'s `authConfig` round-trip.
   */
  getConnectorAuthConfig(provider: string): Record<string, string> | undefined {
    const account = this.getConnectorAccount(provider);
    if (!account?.auth_config) return undefined;
    try {
      return JSON.parse(account.auth_config) as Record<string, string>;
    } catch {
      return undefined;
    }
  }

  updateConnectorTokens(
    accountId: number,
    tokens: {
      accessToken: string;
      refreshToken?: string | null;
      expiry?: string | null;
      scopes?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE connector_accounts SET
           access_token = ?,
           refresh_token = COALESCE(?, refresh_token),
           expiry = ?,
           scopes = COALESCE(?, scopes),
           status = 'connected'
         WHERE id = ?`,
      )
      .run(
        tokens.accessToken,
        tokens.refreshToken ?? null,
        tokens.expiry ?? null,
        tokens.scopes ?? null,
        accountId,
      );
  }

  deleteConnectorAccount(provider: string): void {
    this.db.prepare("DELETE FROM connector_accounts WHERE provider = ?").run(provider);
  }

  getSyncState(accountId: number, kind: string): ConnectorSyncStateRow | undefined {
    return this.db
      .prepare(
        `SELECT account_id, kind, enabled, interval_minutes, sync_token, last_synced_at,
                last_status, config
         FROM connector_sync_state WHERE account_id = ? AND kind = ?`,
      )
      .get(accountId, kind) as ConnectorSyncStateRow | undefined;
  }

  listSyncState(accountId: number): ConnectorSyncStateRow[] {
    return this.db
      .prepare(
        `SELECT account_id, kind, enabled, interval_minutes, sync_token, last_synced_at,
                last_status, config
         FROM connector_sync_state WHERE account_id = ? ORDER BY kind`,
      )
      .all(accountId) as ConnectorSyncStateRow[];
  }

  /** The parsed per-kind coverage config (#68), or an empty object on a fresh/legacy row. */
  getSyncConfig(accountId: number, kind: string): ConnectorKindConfig {
    const row = this.getSyncState(accountId, kind);
    if (!row?.config) return {};
    try {
      return JSON.parse(row.config) as ConnectorKindConfig;
    } catch {
      return {};
    }
  }

  setSyncState(
    accountId: number,
    kind: string,
    patch: {
      enabled?: boolean;
      intervalMinutes?: number;
      syncToken?: string | null;
      lastSyncedAt?: string | null;
      lastStatus?: string | null;
      /** Replace the per-kind coverage config blob (#68); shallow-merged with existing. */
      config?: ConnectorKindConfig;
    },
  ): void {
    // Read-merge-write: create the row on first touch, then patch only the keys
    // present in `patch` so e.g. a cursor write doesn't reset the enabled toggle.
    // (`syncToken: null` deliberately clears the cursor for a full resync.)
    const existing = this.getSyncState(accountId, kind);
    const mergedConfig =
      "config" in patch
        ? { ...this.getSyncConfig(accountId, kind), ...(patch.config ?? {}) }
        : undefined;
    const next = {
      enabled: patch.enabled !== undefined ? Number(patch.enabled) : (existing?.enabled ?? 0),
      intervalMinutes: patch.intervalMinutes ?? existing?.interval_minutes ?? 15,
      syncToken: "syncToken" in patch ? (patch.syncToken ?? null) : (existing?.sync_token ?? null),
      lastSyncedAt:
        "lastSyncedAt" in patch ? (patch.lastSyncedAt ?? null) : (existing?.last_synced_at ?? null),
      lastStatus:
        "lastStatus" in patch ? (patch.lastStatus ?? null) : (existing?.last_status ?? null),
      config: mergedConfig ? JSON.stringify(mergedConfig) : (existing?.config ?? "{}"),
    };
    this.db
      .prepare(
        `INSERT INTO connector_sync_state
           (account_id, kind, enabled, interval_minutes, sync_token, last_synced_at,
            last_status, config)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, kind) DO UPDATE SET
           enabled = excluded.enabled,
           interval_minutes = excluded.interval_minutes,
           sync_token = excluded.sync_token,
           last_synced_at = excluded.last_synced_at,
           last_status = excluded.last_status,
           config = excluded.config`,
      )
      .run(
        accountId,
        kind,
        next.enabled,
        next.intervalMinutes,
        next.syncToken,
        next.lastSyncedAt,
        next.lastStatus,
        next.config,
      );
  }

  /**
   * Coverage stats for a kind (#68): how many distinct items the connector ledger
   * has indexed, and the oldest indexed item's date. The date is parsed from the
   * materialized source's normalized {@link CalendarEventItem}/{@link GmailMessageItem}
   * payload (its `start`/`date`), so it reflects real content recency, not row age.
   */
  connectorCoverageStats(accountId: number, kind: string): ConnectorCoverageStats {
    const count = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM connector_items WHERE account_id = ? AND kind = ? AND source_id IS NOT NULL",
        )
        .get(accountId, kind) as { n: number }
    ).n;

    const rows = this.db
      .prepare(
        `SELECT s.raw_content AS raw
         FROM connector_items ci JOIN sources s ON s.id = ci.source_id
         WHERE ci.account_id = ? AND ci.kind = ? AND s.raw_content IS NOT NULL`,
      )
      .all(accountId, kind) as Array<{ raw: string }>;
    let oldest: string | null = null;
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.raw) as { start?: string | null; date?: string | null };
        const when = parsed.start ?? parsed.date ?? null;
        if (when && (!oldest || when < oldest)) oldest = when;
      } catch {
        /* skip unparseable payloads */
      }
    }
    return { itemCount: count, oldestIndexed: oldest };
  }

  connectorItemUnchanged(
    accountId: number,
    kind: string,
    externalId: string,
    contentHash: string,
  ): boolean {
    const row = this.db
      .prepare(
        "SELECT content_hash FROM connector_items WHERE account_id = ? AND kind = ? AND external_id = ?",
      )
      .get(accountId, kind, externalId) as { content_hash: string | null } | undefined;
    return row?.content_hash != null && row.content_hash === contentHash;
  }

  /**
   * The ledger row for one external item, if it has been seen before — carries the
   * logical source it materialized and the revision that source last advanced to
   * (#19). Used so a re-sync advances the SAME source's revision rather than
   * forking a new source, and so a delta deletion can locate the revision to mark
   * inactive. Returns undefined when the item has never been synced.
   */
  getConnectorItem(
    accountId: number,
    kind: string,
    externalId: string,
  ): ConnectorItemRow | undefined {
    return this.db
      .prepare(
        `SELECT account_id, kind, external_id, content_hash, source_id, source_revision_id, last_seen_at
         FROM connector_items WHERE account_id = ? AND kind = ? AND external_id = ?`,
      )
      .get(accountId, kind, externalId) as ConnectorItemRow | undefined;
  }

  recordConnectorItem(
    accountId: number,
    kind: string,
    externalId: string,
    contentHash: string,
    sourceId: number | null,
    sourceRevisionId?: number | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO connector_items
           (account_id, kind, external_id, content_hash, source_id, source_revision_id, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(account_id, kind, external_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           source_id = COALESCE(excluded.source_id, source_id),
           source_revision_id = COALESCE(excluded.source_revision_id, source_revision_id),
           last_seen_at = datetime('now')`,
      )
      .run(accountId, kind, externalId, contentHash, sourceId, sourceRevisionId ?? null);
  }
}
