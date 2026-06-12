import Database from "better-sqlite3";

const migrations: string[] = [
  // 1 — initial schema
  `
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    path TEXT,
    mime TEXT,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB
  );
  CREATE INDEX idx_chunks_source ON chunks(source_id);

  CREATE TABLE entities (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('person','project','organisation','concept','place','decision')),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    summary TEXT,
    wiki_stale INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE entity_aliases (
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    UNIQUE(entity_id, alias)
  );
  CREATE INDEX idx_aliases_alias ON entity_aliases(alias);

  CREATE TABLE relationships (
    id INTEGER PRIMARY KEY,
    from_entity INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    to_entity INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    source_id INTEGER REFERENCES sources(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(from_entity, to_entity, label)
  );

  CREATE TABLE observations (
    id INTEGER PRIMARY KEY,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    source_id INTEGER REFERENCES sources(id),
    tier TEXT NOT NULL DEFAULT 'observation' CHECK (tier IN ('observation','fact')),
    confidence REAL NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','contradicted')),
    superseded_by INTEGER REFERENCES observations(id),
    embedding BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_confirmed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_observations_entity ON observations(entity_id, status);

  CREATE TABLE contradictions (
    id INTEGER PRIMARY KEY,
    observation_a INTEGER NOT NULL REFERENCES observations(id),
    observation_b INTEGER NOT NULL REFERENCES observations(id),
    note TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE inbox_items (
    id INTEGER PRIMARY KEY,
    source_id INTEGER REFERENCES sources(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','parsing','extracting','merging','done','failed','unsupported')),
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE digests (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];

export type MeosDatabase = Database.Database;

export function openDatabase(file: string): MeosDatabase {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const version = db.pragma("user_version", { simple: true }) as number;
  for (let i = version; i < migrations.length; i++) {
    const migrate = db.transaction(() => {
      db.exec(migrations[i]!);
      db.pragma(`user_version = ${i + 1}`);
    });
    migrate();
  }
  return db;
}
