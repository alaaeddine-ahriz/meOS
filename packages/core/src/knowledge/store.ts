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
  text: string;
  vector: Float32Array;
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
        `SELECT c.id, c.source_id, c.text, c.embedding, s.title AS source_title
         FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE c.embedding IS NOT NULL`,
      )
      .all() as Array<{ id: number; source_id: number; text: string; embedding: Buffer; source_title: string }>;
    return rows.map((row) => ({
      id: row.id,
      source_id: row.source_id,
      source_title: row.source_title,
      text: row.text,
      vector: deserializeVector(row.embedding),
    }));
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
}
