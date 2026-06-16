import type { MeosDatabase } from "../db/database.js";
import { deserializeVector, serializeVector } from "../embedding/vectors.js";
import type { EntityType } from "../extract/schema.js";
import { CONFIDENCE_CAP, REINFORCE_STEP } from "../memory/confidence.js";
import { defaultVisibilityForType, type SourceVisibility } from "./visibility.js";

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

/** One durable ingestion unit — a file/upload/paste tracked across crashes (#13). */
export interface IngestJobRow {
  id: number;
  kind: string;
  queue: IngestQueueKind;
  stage: string;
  state: IngestJobState;
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

/** A connected external account (one row per provider). Carries OAuth secrets. */
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
  status: string;
  created_at: string;
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
export interface WikiRunRow {
  id: number;
  entity_id: number | null;
  source_id: number | null;
  name: string;
  type: string;
  slug: string | null;
  status: "running" | "done" | "failed";
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
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO ingest_jobs
           (kind, queue, payload, inbox_item_id, source_id, content_hash, byte_size, max_attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
   * Atomically claim the oldest runnable job on a queue: a `pending` row whose
   * backoff window (`run_after`) has elapsed, flipped to `processing` and
   * stamped `leased_at` so a crash leaves it recoverable. Opens an `ingest_runs`
   * row for this attempt. Returns the claimed job, or undefined if none is ready.
   */
  claimIngestJob(queue: IngestQueueKind): IngestJobRow | undefined {
    const claim = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM ingest_jobs
           WHERE queue = ? AND state = 'pending' AND run_after <= datetime('now')
           ORDER BY id LIMIT 1`,
        )
        .get(queue) as IngestJobRow | undefined;
      if (!row) return undefined;
      const attempt = row.attempts + 1;
      this.db
        .prepare(
          `UPDATE ingest_jobs
           SET state = 'processing', attempts = ?, leased_at = datetime('now'),
               updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(attempt, row.id);
      this.db
        .prepare(
          `INSERT INTO ingest_runs (job_id, attempt, stage, state)
           VALUES (?, ?, ?, 'processing')`,
        )
        .run(row.id, attempt, row.stage);
      return { ...row, state: "processing" as const, attempts: attempt };
    });
    return claim();
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

  markWikiStale(id: number): void {
    this.db.prepare("UPDATE entities SET wiki_stale = 1 WHERE id = ?").run(id);
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
    entityId: number;
    name: string;
    type: string;
    slug: string;
    sourceIds: number[];
  }): number {
    return Number(
      this.db
        .prepare(
          "INSERT INTO wiki_runs (entity_id, source_id, name, type, slug) VALUES (?, ?, ?, ?, ?)",
        )
        .run(input.entityId, input.sourceIds[0] ?? null, input.name, input.type, input.slug)
        .lastInsertRowid,
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
  orphanEntities(): EntityRow[] {
    return this.db
      .prepare(
        `SELECT * FROM entities e
         WHERE NOT EXISTS (
           SELECT 1 FROM relationships r WHERE r.from_entity = e.id OR r.to_entity = e.id
         )
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

  recentObservations(
    sinceIso: string,
  ): Array<{ text: string; entity_name: string; confidence: number }> {
    return this.db
      .prepare(
        `SELECT o.text, o.confidence, e.name AS entity_name
         FROM observations o JOIN entities e ON e.id = o.entity_id
         WHERE o.created_at >= ? AND o.status = 'active'
         ORDER BY o.id DESC LIMIT 100`,
      )
      .all(sinceIso) as Array<{ text: string; entity_name: string; confidence: number }>;
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
    return messages.map((message) => ({ ...message, sources: byMessage.get(message.id) ?? [] }));
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

  /** Persist the body the writer produced so chat can retrieve compiled prose. */
  upsertWikiPage(entityId: number, body: string, embedding?: Float32Array): void {
    this.db
      .prepare(
        `INSERT INTO wiki_pages (entity_id, body, embedding) VALUES (?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET body = excluded.body,
           embedding = excluded.embedding, updated_at = datetime('now')`,
      )
      .run(entityId, body, embedding ? serializeVector(embedding) : null);
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
  }): number {
    // Update only the columns provided so re-saving credentials never clobbers
    // tokens (and re-connecting never clobbers stored credentials).
    this.db
      .prepare(
        `INSERT INTO connector_accounts
           (provider, account_email, access_token, refresh_token, expiry, scopes, client_id, client_secret, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected')
         ON CONFLICT(provider) DO UPDATE SET
           account_email = COALESCE(excluded.account_email, account_email),
           access_token  = COALESCE(excluded.access_token, access_token),
           refresh_token = COALESCE(excluded.refresh_token, refresh_token),
           expiry        = COALESCE(excluded.expiry, expiry),
           scopes        = COALESCE(excluded.scopes, scopes),
           client_id     = COALESCE(excluded.client_id, client_id),
           client_secret = COALESCE(excluded.client_secret, client_secret),
           status        = CASE WHEN excluded.access_token IS NOT NULL THEN 'connected' ELSE status END`,
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
      );
    return (this.getConnectorAccount(input.provider) as ConnectorAccountRow).id;
  }

  getConnectorAccount(provider: string): ConnectorAccountRow | undefined {
    return this.db
      .prepare(
        `SELECT id, provider, account_email, access_token, refresh_token, expiry, scopes,
                client_id, client_secret, status, created_at
         FROM connector_accounts WHERE provider = ?`,
      )
      .get(provider) as ConnectorAccountRow | undefined;
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
        `SELECT account_id, kind, enabled, interval_minutes, sync_token, last_synced_at, last_status
         FROM connector_sync_state WHERE account_id = ? AND kind = ?`,
      )
      .get(accountId, kind) as ConnectorSyncStateRow | undefined;
  }

  listSyncState(accountId: number): ConnectorSyncStateRow[] {
    return this.db
      .prepare(
        `SELECT account_id, kind, enabled, interval_minutes, sync_token, last_synced_at, last_status
         FROM connector_sync_state WHERE account_id = ? ORDER BY kind`,
      )
      .all(accountId) as ConnectorSyncStateRow[];
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
    },
  ): void {
    // Read-merge-write: create the row on first touch, then patch only the keys
    // present in `patch` so e.g. a cursor write doesn't reset the enabled toggle.
    // (`syncToken: null` deliberately clears the cursor for a full resync.)
    const existing = this.getSyncState(accountId, kind);
    const next = {
      enabled: patch.enabled !== undefined ? Number(patch.enabled) : (existing?.enabled ?? 0),
      intervalMinutes: patch.intervalMinutes ?? existing?.interval_minutes ?? 15,
      syncToken: "syncToken" in patch ? (patch.syncToken ?? null) : (existing?.sync_token ?? null),
      lastSyncedAt:
        "lastSyncedAt" in patch ? (patch.lastSyncedAt ?? null) : (existing?.last_synced_at ?? null),
      lastStatus:
        "lastStatus" in patch ? (patch.lastStatus ?? null) : (existing?.last_status ?? null),
    };
    this.db
      .prepare(
        `INSERT INTO connector_sync_state
           (account_id, kind, enabled, interval_minutes, sync_token, last_synced_at, last_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, kind) DO UPDATE SET
           enabled = excluded.enabled,
           interval_minutes = excluded.interval_minutes,
           sync_token = excluded.sync_token,
           last_synced_at = excluded.last_synced_at,
           last_status = excluded.last_status`,
      )
      .run(
        accountId,
        kind,
        next.enabled,
        next.intervalMinutes,
        next.syncToken,
        next.lastSyncedAt,
        next.lastStatus,
      );
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

  recordConnectorItem(
    accountId: number,
    kind: string,
    externalId: string,
    contentHash: string,
    sourceId: number | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO connector_items (account_id, kind, external_id, content_hash, source_id, last_seen_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(account_id, kind, external_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           source_id = COALESCE(excluded.source_id, source_id),
           last_seen_at = datetime('now')`,
      )
      .run(accountId, kind, externalId, contentHash, sourceId);
  }
}
