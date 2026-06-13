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
  // 2 — user-configured watch folders + ledger of files already absorbed
  `
  CREATE TABLE watched_folders (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE ingested_files (
    path TEXT PRIMARY KEY,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 3 — repair: early watch ingests stored the absolute file path in 'type'
  // and only the basename in 'path'; reveal-in-Finder needs the full path
  `
  UPDATE sources SET path = type, type = 'watch' WHERE type LIKE '/%';
  `,
  // 4 — which documents each assistant reply drew on, so citations survive
  // reloading a conversation
  `
  CREATE TABLE message_sources (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    UNIQUE(message_id, source_id)
  );
  CREATE INDEX idx_message_sources_message ON message_sources(message_id);
  `,
  // 5 — app settings configured in the UI (LLM provider, model, API keys);
  // values are JSON. Lives in the DB so saving never touches source-adjacent
  // files (a config-file write restarts the dev server mid-request).
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 6 — wiki change tracking: which document made each page stale (pending
  // bridge from merge to regeneration), and the git commits each regeneration
  // pass produced, attributed per source + file so a batched commit can still
  // be sliced back to a single document's diff.
  `
  CREATE TABLE wiki_stale_sources (
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    UNIQUE(entity_id, source_id)
  );

  CREATE TABLE wiki_commits (
    id INTEGER PRIMARY KEY,
    hash TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE wiki_commit_changes (
    id INTEGER PRIMARY KEY,
    commit_id INTEGER NOT NULL REFERENCES wiki_commits(id) ON DELETE CASCADE,
    entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    file_path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('created','updated'))
  );
  CREATE INDEX idx_wcc_commit ON wiki_commit_changes(commit_id);
  CREATE INDEX idx_wcc_source ON wiki_commit_changes(source_id);
  `,
  // 7 — hybrid retrieval + provenance. Observations record every document that
  // backs them (confidence is then a function of source count, not an ad-hoc
  // bump); wiki prose is persisted so chat can retrieve the *compiled* knowledge
  // rather than re-deriving from raw chunks; and FTS5 indexes give BM25 keyword
  // ranking, fused with vector ranks via reciprocal rank fusion at query time.
  `
  CREATE TABLE observation_sources (
    observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(observation_id, source_id)
  );
  CREATE INDEX idx_obs_sources_obs ON observation_sources(observation_id);
  -- backfill the single source each observation already carried
  INSERT OR IGNORE INTO observation_sources (observation_id, source_id)
    SELECT id, source_id FROM observations WHERE source_id IS NOT NULL;

  CREATE TABLE wiki_pages (
    entity_id INTEGER PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    embedding BLOB,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id');
  INSERT INTO chunks_fts(rowid, text) SELECT id, text FROM chunks;
  CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;

  CREATE VIRTUAL TABLE observations_fts USING fts5(text, content='observations', content_rowid='id');
  INSERT INTO observations_fts(rowid, text) SELECT id, text FROM observations;
  CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER observations_au AFTER UPDATE OF text ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO observations_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE VIRTUAL TABLE wiki_fts USING fts5(body, content='wiki_pages', content_rowid='entity_id');
  CREATE TRIGGER wiki_pages_ai AFTER INSERT ON wiki_pages BEGIN
    INSERT INTO wiki_fts(rowid, body) VALUES (new.entity_id, new.body);
  END;
  CREATE TRIGGER wiki_pages_ad AFTER DELETE ON wiki_pages BEGIN
    INSERT INTO wiki_fts(wiki_fts, rowid, body) VALUES ('delete', old.entity_id, old.body);
  END;
  CREATE TRIGGER wiki_pages_au AFTER UPDATE OF body ON wiki_pages BEGIN
    INSERT INTO wiki_fts(wiki_fts, rowid, body) VALUES ('delete', old.entity_id, old.body);
    INSERT INTO wiki_fts(rowid, body) VALUES (new.entity_id, new.body);
  END;
  `,
  // 8 — richer claims: each observation gains a kind, the exact supporting quote
  // and its char span in the source (provenance), validity window, and a
  // sensitivity tier that keeps private/secret claims out of the wiki.
  `
  ALTER TABLE observations ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact';
  ALTER TABLE observations ADD COLUMN source_quote TEXT;
  ALTER TABLE observations ADD COLUMN char_start INTEGER;
  ALTER TABLE observations ADD COLUMN char_end INTEGER;
  ALTER TABLE observations ADD COLUMN valid_from TEXT;
  ALTER TABLE observations ADD COLUMN valid_until TEXT;
  ALTER TABLE observations ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal';
  `,
  // 9 — memory tiers: an abstraction ladder over the corroboration tier. A
  // claim is working (fresh/single-source), episodic (tied to an event/session),
  // semantic (stable, corroborated across sources), or procedural (a how-to).
  // Reclassified each consolidation as evidence accumulates.
  `
  ALTER TABLE observations ADD COLUMN memory_tier TEXT NOT NULL DEFAULT 'working';
  CREATE INDEX idx_observations_tier ON observations(memory_tier, status);
  `,
  // 10 — typed-graph lifecycle: relationships gain a confidence (rising with
  // each independent source, like observations), a status (active/superseded/
  // contradicted) so traversal can ignore retired edges, and per-source
  // provenance.
  `
  ALTER TABLE relationships ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
  ALTER TABLE relationships ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

  CREATE TABLE relationship_sources (
    relationship_id INTEGER NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(relationship_id, source_id)
  );
  CREATE INDEX idx_rel_sources_rel ON relationship_sources(relationship_id);
  INSERT OR IGNORE INTO relationship_sources (relationship_id, source_id)
    SELECT id, source_id FROM relationships WHERE source_id IS NOT NULL;
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
