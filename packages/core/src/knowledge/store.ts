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

  // --- relationships ---

  upsertRelationship(fromEntity: number, toEntity: number, label: string, sourceId?: number): void {
    this.db
      .prepare(
        `INSERT INTO relationships (from_entity, to_entity, label, source_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(from_entity, to_entity, label) DO NOTHING`,
      )
      .run(fromEntity, toEntity, label, sourceId ?? null);
  }

  relationshipsFor(entityId: number): RelationshipView[] {
    return this.db
      .prepare(
        `SELECT r.id, r.label, r.from_entity, r.to_entity,
                ef.name AS from_name, et.name AS to_name
         FROM relationships r
         JOIN entities ef ON ef.id = r.from_entity
         JOIN entities et ON et.id = r.to_entity
         WHERE r.from_entity = ? OR r.to_entity = ?`,
      )
      .all(entityId, entityId) as RelationshipView[];
  }

  // --- observations ---

  insertObservation(input: {
    entityId: number;
    text: string;
    sourceId?: number;
    embedding?: Float32Array;
    confidence?: number;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO observations (entity_id, text, source_id, confidence, embedding)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.entityId,
        input.text,
        input.sourceId ?? null,
        input.confidence ?? 0.5,
        input.embedding ? serializeVector(input.embedding) : null,
      );
    return Number(result.lastInsertRowid);
  }

  activeObservations(entityId: number): ObservationRow[] {
    return this.db
      .prepare(
        `SELECT id, entity_id, text, source_id, tier, confidence, status, superseded_by,
                created_at, last_confirmed_at
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
                created_at, last_confirmed_at
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

  listConversations(): Array<{ id: number; title: string | null; created_at: string }> {
    return this.db
      .prepare("SELECT id, title, created_at FROM conversations ORDER BY id DESC")
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

  listMessages(conversationId: number): Array<{
    id: number;
    role: "user" | "assistant";
    content: string;
    created_at: string;
  }> {
    return this.db
      .prepare("SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id")
      .all(conversationId) as Array<{
      id: number;
      role: "user" | "assistant";
      content: string;
      created_at: string;
    }>;
  }

  reinforceObservation(id: number): void {
    this.db
      .prepare(
        `UPDATE observations
         SET confidence = MIN(0.95, confidence + 0.15), last_confirmed_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);
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
