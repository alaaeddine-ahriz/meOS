import type { MeosDatabase } from "../db/database.js";
import { deserializeVector, serializeVector } from "../embedding/vectors.js";
import type { EntityType } from "../extract/schema.js";

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
}

export interface SourceRef {
  id: number;
  title: string;
  path: string | null;
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

  createSource(input: { type: string; title: string; path?: string; mime?: string; content: string }): number {
    const result = this.db
      .prepare("INSERT INTO sources (type, title, path, mime, content) VALUES (?, ?, ?, ?, ?)")
      .run(input.type, input.title, input.path ?? null, input.mime ?? null, input.content);
    return Number(result.lastInsertRowid);
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

  /** A source's type (file/image/conversation/session…) — drives source quality and tiering. */
  getSourceType(id: number): string | undefined {
    const row = this.db.prepare("SELECT type FROM sources WHERE id = ?").get(id) as
      | { type: string }
      | undefined;
    return row?.type;
  }

  addChunks(sourceId: number, chunks: Array<{ text: string; embedding: Float32Array }>): void {
    const insert = this.db.prepare(
      "INSERT INTO chunks (source_id, seq, text, embedding) VALUES (?, ?, ?, ?)",
    );
    const insertAll = this.db.transaction(() => {
      chunks.forEach((chunk, seq) => {
        insert.run(sourceId, seq, chunk.text, serializeVector(chunk.embedding));
      });
    });
    insertAll();
  }

  allChunks(): ChunkWithVector[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.source_id, c.text, c.embedding, s.title AS source_title, s.path AS source_path
         FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE c.embedding IS NOT NULL`,
      )
      .all() as Array<{
      id: number;
      source_id: number;
      text: string;
      embedding: Buffer;
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
    }));
  }

  getSource(id: number): SourceRef | undefined {
    return this.db.prepare("SELECT id, title, path FROM sources WHERE id = ?").get(id) as
      | SourceRef
      | undefined;
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
        `SELECT DISTINCT s.id, s.title, s.path
         FROM observations o JOIN sources s ON s.id = o.source_id
         WHERE o.entity_id = ? AND o.status = 'active'
         ORDER BY s.title`,
      )
      .all(entityId) as SourceRef[];
  }

  // --- inbox ---

  createInboxItem(title: string, sourceId?: number): number {
    const result = this.db
      .prepare("INSERT INTO inbox_items (title, source_id) VALUES (?, ?)")
      .run(title, sourceId ?? null);
    return Number(result.lastInsertRowid);
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
    return this.db
      .prepare("SELECT * FROM inbox_items ORDER BY id DESC LIMIT ?")
      .all(limit) as InboxItemRow[];
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
    return this.db.prepare("SELECT * FROM entities WHERE slug = ?").get(slug) as EntityRow | undefined;
  }

  listEntities(): EntityRow[] {
    return this.db.prepare("SELECT * FROM entities ORDER BY type, name").all() as EntityRow[];
  }

  staleEntities(): EntityRow[] {
    return this.db.prepare("SELECT * FROM entities WHERE wiki_stale = 1").all() as EntityRow[];
  }

  addAlias(entityId: number, alias: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO entity_aliases (entity_id, alias) VALUES (?, ?)")
      .run(entityId, alias.trim());
  }

  aliasesFor(entityId: number): string[] {
    return (
      this.db.prepare("SELECT alias FROM entity_aliases WHERE entity_id = ?").all(entityId) as Array<{
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

  // --- relationships ---

  /**
   * Record a relationship from a source. A repeat from a *new* source raises the
   * edge's confidence (like an observation); the same source never inflates it.
   * Returns true only when the edge was newly created.
   */
  upsertRelationship(fromEntity: number, toEntity: number, label: string, sourceId?: number): boolean {
    const existing = this.db
      .prepare("SELECT id FROM relationships WHERE from_entity = ? AND to_entity = ? AND label = ?")
      .get(fromEntity, toEntity, label) as { id: number } | undefined;
    if (existing) {
      if (sourceId !== undefined) {
        const isNewSource =
          this.db
            .prepare("INSERT OR IGNORE INTO relationship_sources (relationship_id, source_id) VALUES (?, ?)")
            .run(existing.id, sourceId).changes > 0;
        if (isNewSource) {
          this.db
            .prepare("UPDATE relationships SET confidence = MIN(0.95, confidence + 0.15) WHERE id = ?")
            .run(existing.id);
        }
      }
      return false;
    }
    const id = Number(
      this.db
        .prepare("INSERT INTO relationships (from_entity, to_entity, label, source_id) VALUES (?, ?, ?, ?)")
        .run(fromEntity, toEntity, label, sourceId ?? null).lastInsertRowid,
    );
    if (sourceId !== undefined) {
      this.db
        .prepare("INSERT OR IGNORE INTO relationship_sources (relationship_id, source_id) VALUES (?, ?)")
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
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO observations
           (entity_id, text, source_id, confidence, embedding, kind, source_quote,
            char_start, char_end, valid_from, valid_until, sensitivity, memory_tier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    const id = Number(result.lastInsertRowid);
    if (input.sourceId !== undefined) this.recordObservationSource(id, input.sourceId);
    return id;
  }

  /** Record a document as backing an observation; true when it is a new source. */
  recordObservationSource(observationId: number, sourceId: number): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO observation_sources (observation_id, source_id) VALUES (?, ?)")
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
      | { id: number; entity_id: number; observation_a: number; observation_b: number; note: string | null; resolved: number }
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
  observationTierInputs(): Array<{ id: number; kind: string; source_type: string | null; source_count: number; memory_tier: string }> {
    return this.db
      .prepare(
        `SELECT o.id, o.kind, o.memory_tier, s.type AS source_type,
                (SELECT COUNT(*) FROM observation_sources os WHERE os.observation_id = o.id) AS source_count
         FROM observations o LEFT JOIN sources s ON s.id = o.source_id
         WHERE o.status = 'active'`,
      )
      .all() as Array<{ id: number; kind: string; source_type: string | null; source_count: number; memory_tier: string }>;
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

  recentSources(sinceIso: string): Array<{ id: number; title: string; type: string; created_at: string }> {
    return this.db
      .prepare("SELECT id, title, type, created_at FROM sources WHERE created_at >= ? ORDER BY id DESC")
      .all(sinceIso) as Array<{ id: number; title: string; type: string; created_at: string }>;
  }

  recentObservations(sinceIso: string): Array<{ text: string; entity_name: string; confidence: number }> {
    return this.db
      .prepare(
        `SELECT o.text, o.confidence, e.name AS entity_name
         FROM observations o JOIN entities e ON e.id = o.entity_id
         WHERE o.created_at >= ? AND o.status = 'active'
         ORDER BY o.id DESC LIMIT 100`,
      )
      .all(sinceIso) as Array<{ text: string; entity_name: string; confidence: number }>;
  }

  recentlySuperseded(sinceIso: string): Array<{ old_text: string; new_text: string; entity_name: string }> {
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
    return this.db
      .prepare("SELECT date, content FROM digests ORDER BY date DESC LIMIT 1")
      .get() as { date: string; content: string } | undefined;
  }

  // --- conversations ---

  createConversation(title?: string): number {
    const result = this.db.prepare("INSERT INTO conversations (title) VALUES (?)").run(title ?? null);
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
      .prepare("SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id")
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

  /**
   * A new document restating an existing fact corroborates it: confidence rises
   * (capped) only when the source is genuinely new, so re-reading the same
   * document never inflates it — confidence tracks *source count*, not mentions.
   * Re-confirmation always refreshes recency so the fact resists decay.
   */
  /** What the user typed in chat since a cutoff — raw material for crystallization. */
  recentUserMessages(sinceIso: string): Array<{ content: string; created_at: string }> {
    return this.db
      .prepare(
        `SELECT content, created_at FROM messages
         WHERE role = 'user' AND created_at >= ? ORDER BY id`,
      )
      .all(sinceIso) as Array<{ content: string; created_at: string }>;
  }

  reinforceObservation(id: number, sourceId?: number): void {
    const distinctSource = sourceId === undefined ? true : this.recordObservationSource(id, sourceId);
    this.db
      .prepare(
        distinctSource
          ? `UPDATE observations
             SET confidence = MIN(0.95, confidence + 0.15), last_confirmed_at = datetime('now')
             WHERE id = ?`
          : "UPDATE observations SET last_confirmed_at = datetime('now') WHERE id = ?",
      )
      .run(id);
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
  wikiPageBodies(): Array<{ entity_id: number; entity_name: string; slug: string; type: string; body: string }> {
    return this.db
      .prepare(
        `SELECT w.entity_id, w.body, e.name AS entity_name, e.slug, e.type
         FROM wiki_pages w JOIN entities e ON e.id = w.entity_id`,
      )
      .all() as Array<{ entity_id: number; entity_name: string; slug: string; type: string; body: string }>;
  }

  /** Persist a page's lint score (0..1). */
  setWikiQuality(entityId: number, quality: number): void {
    this.db.prepare("UPDATE wiki_pages SET quality = ? WHERE entity_id = ?").run(quality, entityId);
  }

  /** Pages below a quality threshold, worst first — surfaced for review. */
  lowQualityPages(threshold = 0.6): Array<{ entity_id: number; entity_name: string; quality: number }> {
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

  /** True unless this exact file version (path + mtime + size) was absorbed before. */
  fileNeedsIngest(filePath: string, mtimeMs: number, size: number): boolean {
    const row = this.db
      .prepare("SELECT mtime_ms, size FROM ingested_files WHERE path = ?")
      .get(filePath) as { mtime_ms: number; size: number } | undefined;
    return !row || row.mtime_ms !== Math.floor(mtimeMs) || row.size !== size;
  }

  recordIngestedFile(filePath: string, mtimeMs: number, size: number): void {
    this.db
      .prepare(
        `INSERT INTO ingested_files (path, mtime_ms, size) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size,
           ingested_at = datetime('now')`,
      )
      .run(filePath, Math.floor(mtimeMs), size);
  }
}
