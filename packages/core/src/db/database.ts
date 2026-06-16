import Database from "better-sqlite3";

/**
 * The ordered DDL migrations. Index i upgrades user_version i → i+1. Exported
 * (read-only) so tests can stand up a DB at a specific historical version and
 * assert the next migration applies cleanly — never mutate it.
 */
export const migrations: readonly string[] = [
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
  // 11 — quality scoring: the linter writes a 0..1 health score per wiki page so
  // low-quality pages surface for review and the digest can report wiki health.
  `
  ALTER TABLE wiki_pages ADD COLUMN quality REAL;
  `,
  // 12 — governance: an append-only audit trail of memory operations, each with
  // a justification, so every automated change to the knowledge base is
  // accountable and reviewable.
  `
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    op TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_audit_created ON audit_log(id DESC);
  `,
  // 13 — human-gated dedup, the "no" branch: a merge proposal the user dismisses
  // is remembered (by entity-id pair, order-normalised) so detection stops
  // re-surfacing the same pair on every reload.
  `
  CREATE TABLE dismissed_duplicates (
    a_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    b_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (a_id, b_id)
  );
  `,
  // 14 — wiki-maintainer transcripts: each agentic page regeneration is a "run"
  // whose reasoning + tool calls are recorded as ordered events, so the Activity
  // view can replay a run after the fact (and stream it live as it happens).
  `
  CREATE TABLE wiki_runs (
    id INTEGER PRIMARY KEY,
    entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    slug TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX idx_wiki_runs_created ON wiki_runs(id DESC);

  CREATE TABLE wiki_run_events (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES wiki_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('reasoning','tool-call','tool-result','text')),
    tool_name TEXT,
    payload TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_wiki_run_events_run ON wiki_run_events(run_id, seq);
  `,
  // 15 — make the Inbox feed file-centric: a watched file gets one row, keyed
  // by its path, that is reset in place each time the file changes (revision++)
  // instead of appending a fresh duplicate event. Uploads keep path NULL.
  `
  ALTER TABLE inbox_items ADD COLUMN path TEXT;
  ALTER TABLE inbox_items ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX idx_inbox_items_path ON inbox_items(path);
  `,
  // 16 — content hash on the ingest ledger. mtime+size stays the cheap
  // pre-filter; the hash (computed from the buffer we already read to ingest)
  // confirms whether the bytes actually changed, so a metadata-only touch
  // (cloud re-download, backup restore, `touch`) no longer triggers a needless
  // re-ingest. Indexed so a moved/renamed file can later be recognised by content.
  `
  ALTER TABLE ingested_files ADD COLUMN content_hash TEXT;
  CREATE INDEX idx_ingested_files_hash ON ingested_files(content_hash);
  `,
  // 17 — external connectors (Google Contacts/Calendar/Gmail). One account row
  // per connected provider (tokens live in the DB, never near source files — same
  // rationale as the settings table at #5); a per-kind sync cursor + schedule; and
  // a content-hash ledger modelled on ingested_files so an unchanged item is
  // skipped on re-sync rather than re-merged. Each ledger row points at the source
  // it created (ON DELETE SET NULL) so deletions don't orphan the link.
  `
  CREATE TABLE connector_accounts (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    account_email TEXT,
    access_token TEXT,
    refresh_token TEXT,
    expiry TEXT,
    scopes TEXT,
    client_id TEXT,
    client_secret TEXT,
    status TEXT NOT NULL DEFAULT 'connected',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider)
  );

  CREATE TABLE connector_sync_state (
    account_id INTEGER NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('contacts','calendar','gmail')),
    enabled INTEGER NOT NULL DEFAULT 0,
    interval_minutes INTEGER NOT NULL DEFAULT 15,
    sync_token TEXT,
    last_synced_at TEXT,
    last_status TEXT,
    UNIQUE(account_id, kind)
  );

  CREATE TABLE connector_items (
    account_id INTEGER NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL,
    content_hash TEXT,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, kind, external_id)
  );
  CREATE INDEX idx_connector_items_lookup ON connector_items(account_id, kind, external_id);
  `,
  // 18 — source-level visibility (privacy). Until now privacy lived only at the
  // observation tier (sensitivity normal|private|secret, filtered by
  // visibleObservations). A source now also carries six surface permissions, so a
  // whole document/connector can be scoped without per-claim tagging:
  //   searchable       — eligible as a retrieval candidate at all
  //   answerable       — may back a chat answer's citations
  //   wiki_eligible    — its observations may feed a generated wiki page
  //   syncable         — its derived content may be git-synced to a remote
  //   exportable       — its derived content may appear in exports/digests
  //   activity_visible — it may surface in the Activity / recent-sources feed
  // Stored as integer booleans (0/1). Backfilled by type so existing rows keep
  // today's behaviour: connector-derived sources (google:contacts|calendar|gmail)
  // are private by default — searchable/answerable but NOT syncable/exportable
  // (aligns with the existing privacy stance: connector PII stays off portable,
  // remote-pushed artifacts). Profile context is searchable/answerable but kept
  // out of the wiki and out of sync/export. Everything else (local files, watched
  // folders, uploads, vault notes, pasted text, conversations, sessions) defaults
  // to fully permissive, exactly as before this migration.
  `
  ALTER TABLE sources ADD COLUMN searchable INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE sources ADD COLUMN answerable INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE sources ADD COLUMN wiki_eligible INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE sources ADD COLUMN syncable INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE sources ADD COLUMN exportable INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE sources ADD COLUMN activity_visible INTEGER NOT NULL DEFAULT 1;

  -- Backfill: connector sources are private by default (no sync/export).
  UPDATE sources SET syncable = 0, exportable = 0
    WHERE type IN ('google:contacts', 'google:calendar', 'google:gmail');

  -- Backfill: profile-context docs are not wiki/sync/export material.
  UPDATE sources SET wiki_eligible = 0, syncable = 0, exportable = 0
    WHERE type = 'profile_context';
  `,
  // 19 — structure-aware ingestion (#14). Chunks gain provenance/navigation
  // metadata so a retrieval result can travel chunk → section → page → source,
  // and citations can point at a page/section/char-span, not just a document:
  //   source_block_ids   — JSON array of the parsed Block ids this chunk spans
  //   section_title      — nearest enclosing heading (retrieval can boost it)
  //   page_start/page_end— 1-based page range (PDFs), nullable
  //   char_start/char_end— span in the source's normalized text, nullable
  //   token_estimate     — cheap chars/4 estimate, for budgeting
  //   content_type       — dominant block type (paragraph/list/table/code/heading)
  //   source_revision_id — PLACEHOLDER for #16 (source revisions); nullable now,
  //                        so revision-aware re-chunking can backfill it later
  //                        without another chunk-table migration.
  // Sources now store the raw bytes-as-text separately from the normalized text,
  // so future parsers can be re-run without re-reading the original file:
  //   raw_content        — the unnormalized source text (content stays normalized).
  // All columns are nullable, so the backfill is a no-op on existing rows.
  `
  ALTER TABLE chunks ADD COLUMN source_block_ids TEXT;
  ALTER TABLE chunks ADD COLUMN section_title TEXT;
  ALTER TABLE chunks ADD COLUMN page_start INTEGER;
  ALTER TABLE chunks ADD COLUMN page_end INTEGER;
  ALTER TABLE chunks ADD COLUMN char_start INTEGER;
  ALTER TABLE chunks ADD COLUMN char_end INTEGER;
  ALTER TABLE chunks ADD COLUMN token_estimate INTEGER;
  ALTER TABLE chunks ADD COLUMN content_type TEXT;
  ALTER TABLE chunks ADD COLUMN source_revision_id INTEGER;

  ALTER TABLE sources ADD COLUMN raw_content TEXT;
  `,
  // 20 — source revisions (#16). One logical source (sources.id) now owns an
  // ordered history of content versions, so retrieval/wiki can tell "this fact
  // came from the old version" from "still current", and a delete/rename is
  // visible and recoverable rather than silently kept as live.
  //
  //   source_revisions       — one row per ingested version of a source.
  //     revision             — monotonic per source (1, 2, 3…).
  //     status               — the version's lifecycle:
  //         active      the current, in-effect version
  //         superseded  replaced by a newer revision of the same source
  //         missing     the backing file vanished (watched file deleted on disk)
  //         deleted     explicitly removed (folder unwatched / source deleted)
  //         failed      an ingest attempt that errored before completing
  //         incomplete  a revision opened but not yet finalized
  //     content_hash         — sha256 of the raw bytes, for dedup/provenance.
  //     raw_content /        — the version's reconstructable content blob, kept
  //     normalized_content     so an old revision can be re-parsed or shown even
  //                            after the live source row moved on. GC (see
  //                            gcOrphanedRevisionBlobs) nulls these once a
  //                            superseded/deleted revision is no longer needed.
  //
  // Derived rows link to the exact revision that produced them, so a fact can be
  // flagged the moment its only supporting revision is superseded/deleted/missing:
  //   chunks.source_revision_id        (placeholder from #19, now populated)
  //   observations.source_revision_id
  //   relationships.source_revision_id
  //
  // Backfill: every existing source gets one `active` revision (revision 1) whose
  // content blobs mirror the source's current content, and every existing chunk/
  // observation/relationship is pointed at it. Idempotent on a fresh DB (no rows).
  `
  CREATE TABLE source_revisions (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active','missing','deleted','superseded','failed','incomplete')),
    content_hash TEXT,
    raw_content TEXT,
    normalized_content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_id, revision)
  );
  CREATE INDEX idx_source_revisions_source ON source_revisions(source_id, revision);
  CREATE INDEX idx_source_revisions_status ON source_revisions(status);

  ALTER TABLE observations ADD COLUMN source_revision_id INTEGER REFERENCES source_revisions(id);
  ALTER TABLE relationships ADD COLUMN source_revision_id INTEGER REFERENCES source_revisions(id);
  CREATE INDEX idx_observations_revision ON observations(source_revision_id);
  CREATE INDEX idx_relationships_revision ON relationships(source_revision_id);

  -- Backfill: one active revision per existing source, mirroring its content.
  INSERT INTO source_revisions
    (source_id, revision, status, content_hash, raw_content, normalized_content, created_at)
    SELECT id, 1, 'active', NULL, raw_content, content, created_at FROM sources;

  -- Point existing derived rows at their source's (sole) active revision.
  UPDATE chunks SET source_revision_id = (
    SELECT sr.id FROM source_revisions sr WHERE sr.source_id = chunks.source_id
  ) WHERE source_revision_id IS NULL;
  UPDATE observations SET source_revision_id = (
    SELECT sr.id FROM source_revisions sr WHERE sr.source_id = observations.source_id
  ) WHERE source_id IS NOT NULL AND source_revision_id IS NULL;
  UPDATE relationships SET source_revision_id = (
    SELECT sr.id FROM source_revisions sr WHERE sr.source_id = relationships.source_id
  ) WHERE source_id IS NOT NULL AND source_revision_id IS NULL;
  `,

  // 21 — durable, resumable ingestion jobs (#13).
  //
  // The ingestion pipeline was best-effort and in-memory: a crash mid-ingest
  // could leave half-written state with no record of what was in flight, and a
  // failed extraction left no way to retry without re-reading the file. These
  // two tables make each ingestion unit durable.
  //
  //   ingest_jobs — one row per logical ingestion unit (a file, an upload, a
  //   paste). Carries the input kind, the dedicated queue it rides (`extraction`
  //   for the full parse→embed→extract→merge flow; `embedding` reserved for the
  //   search-only re-index #15/#18 will lean on), the current stage state, an
  //   attempt counter for bounded retries with backoff, the resolved source_id +
  //   source_revision_id (#16) once known, the content hash + byte size for
  //   debugging/dedup, and the last error. `payload` holds a small JSON pointer
  //   to the input (path or inbox item) — never raw buffers, which stay on disk.
  //
  //   ingest_runs — the append-only attempt history for a job: one row per run,
  //   with the stage it reached, its outcome, timing, and any error. This is the
  //   audit/debug trail (#18 reads per-stage timings/counts off it) and what the
  //   retention sweep prunes once a job has long since completed.
  //
  // `state` lifecycle per job: pending → processing → completed | failed, with
  // failed jobs retried (back to pending, attempts++) until `max_attempts`, then
  // parked at `dead-letter` for a manual retry from the inbox.
  `
  -- The durable pipeline can leave a source searchable while its semantic
  -- extraction failed (the index commits independently of extraction). Surface
  -- that as a distinct, retryable inbox state ('extract-failed') so the feed
  -- shows "searchable — extraction failed" rather than a hard 'failed'. SQLite
  -- can't relax a CHECK in place, so rebuild inbox_items with the wider set,
  -- copying every row and restoring the path index. Done before ingest_jobs is
  -- created so no FK references inbox_items while it is dropped.
  CREATE TABLE inbox_items_new (
    id INTEGER PRIMARY KEY,
    source_id INTEGER REFERENCES sources(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','parsing','extracting','merging','done','failed','unsupported','extract-failed')),
    detail TEXT,
    path TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO inbox_items_new
    (id, source_id, title, status, detail, path, revision, created_at, updated_at)
    SELECT id, source_id, title, status, detail, path, revision, created_at, updated_at
    FROM inbox_items;
  DROP TABLE inbox_items;
  ALTER TABLE inbox_items_new RENAME TO inbox_items;
  CREATE INDEX idx_inbox_items_path ON inbox_items(path);

  CREATE TABLE ingest_jobs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    queue TEXT NOT NULL DEFAULT 'extraction'
      CHECK (queue IN ('extraction','embedding')),
    stage TEXT NOT NULL DEFAULT 'queued',
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending','processing','completed','failed','dead-letter')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    payload TEXT,
    inbox_item_id INTEGER REFERENCES inbox_items(id) ON DELETE SET NULL,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    source_revision_id INTEGER REFERENCES source_revisions(id) ON DELETE SET NULL,
    content_hash TEXT,
    byte_size INTEGER,
    last_error TEXT,
    -- When the current processing attempt began, so a stale (crashed) job is
    -- recoverable; cleared on completion/failure.
    leased_at TEXT,
    -- When this job is next eligible to run, used for retry backoff.
    run_after TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_ingest_jobs_state ON ingest_jobs(state, queue, run_after);
  CREATE INDEX idx_ingest_jobs_source ON ingest_jobs(source_id);
  CREATE INDEX idx_ingest_jobs_inbox ON ingest_jobs(inbox_item_id);

  CREATE TABLE ingest_runs (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES ingest_jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    stage TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('processing','completed','failed','dead-letter')),
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX idx_ingest_runs_job ON ingest_runs(job_id, attempt);
  `,

  // 22 — per-section extraction cache for map-reduce large-document extraction (#15).
  //
  // Large documents are extracted section-by-section (map) and the partials are
  // deterministically reduced into one Extraction before merge. Each map output
  // is the result of one LLM call over a section, and re-extracting a source —
  // after a prompt/model/schema/profile change, or just a retry — should reuse
  // any partial whose inputs are byte-identical instead of paying for the call
  // again. This table is that cache.
  //
  // The cache key is (source_revision_id, content_hash, schema_version,
  // prompt_version, model_id, profile_version): the revision + the section's
  // content hash identify *what* was extracted, and the four version components
  // identify *how*. A change to any version component yields a different key, so
  // stale partials are never served — they simply miss and are recomputed. Old
  // rows are left in place (a later revision's sweep / source deletion cascades
  // them away via the FK); they cost nothing once unreferenced.
  //
  // `extraction` is the partial Extraction JSON. `token_usage` records the LLM
  // tokens the map call spent (0 on a cache hit, by definition). `strategy`
  // records whether the owning extraction ran 'single' (whole-doc one-pass) or
  // 'map-reduce' — surfaced for cost/telemetry and so a single-pass result can
  // be cached under the same table without pretending it was sectioned.
  `
  CREATE TABLE extraction_cache (
    id INTEGER PRIMARY KEY,
    source_revision_id INTEGER NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    model_id TEXT NOT NULL,
    profile_version TEXT NOT NULL,
    strategy TEXT NOT NULL CHECK (strategy IN ('single','map-reduce')),
    extraction TEXT NOT NULL,
    token_usage INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_revision_id, content_hash, schema_version, prompt_version, model_id, profile_version)
  );
  CREATE INDEX idx_extraction_cache_revision ON extraction_cache(source_revision_id);
  `,

  // 23 — connector materialization layer (#19).
  //
  // Until now a changed connector item was mapped straight into an Extraction and
  // merged via ingestExtraction(): no document, no chunks, no revision history —
  // an item only became searchable once it produced entities/observations, and a
  // re-sync re-merged into a fresh source row. #19 inserts a materialization stage
  // before semantic extraction: each changed item becomes a *logical source* plus
  // a *source revision* (raw payload stored separately from the normalized text),
  // its normalized text is chunked/embedded/indexed so it is searchable even when
  // extraction later fails, and semantic extraction runs as a derived stage off
  // the SAVED revision.
  //
  // The `connector_items` ledger (migration 17) already links
  // (account_id, kind, external_id) → source_id; this migration adds
  // `source_revision_id` so the ledger also names the exact revision the item last
  // materialized. Re-syncing a changed item advances the SAME logical source's
  // revision (the prior active one is superseded) instead of forking a new source;
  // a deletion marks that revision inactive (deleted/missing) without losing the
  // audit trail. The column is nullable (legacy ledger rows predate revisions) and
  // ON DELETE SET NULL so dropping a revision never orphans the ledger row.
  `
  ALTER TABLE connector_items ADD COLUMN source_revision_id INTEGER
    REFERENCES source_revisions(id) ON DELETE SET NULL;
  `,

  // 24 — ingest job priority class for budgets/backpressure (#18).
  //
  // Until now the durable extraction queue claimed jobs strictly by id (FIFO by
  // creation), so a 1000-file bulk import could sit ahead of a just-uploaded
  // note the user is waiting on. #18 adds a `priority` class so high-value work
  // drains first: a user upload (40) outranks a watched file (30), which
  // outranks a connector background sync (20), which outranks nightly
  // maintenance (10). `claimIngestJob` now orders by (priority DESC, id ASC), so
  // within a class the queue stays strictly FIFO and scheduling is deterministic.
  //
  // The column is backfilled to 30 (the watched-file default) for every existing
  // row — the historical behaviour for durable jobs, which were only ever files
  // and uploads — and defaults to 30 for new rows so a caller that omits it is
  // unchanged. A new composite index keys the priority-aware claim scan.
  `
  ALTER TABLE ingest_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 30;
  CREATE INDEX idx_ingest_jobs_claim
    ON ingest_jobs(queue, state, priority, run_after);
  `,

  // 25 — provider-agnostic connector kinds (#5).
  //
  // `connector_sync_state.kind` carried a CHECK constraint pinned to Google's
  // three kinds (`contacts','calendar','gmail`), which made the connector
  // framework's central promise — "a new connector slots in without touching the
  // pipeline" — false at the storage layer: a second provider's kind (an IMAP
  // mailbox, a Notion database, a local folder) would be rejected by the DB.
  //
  // SQLite can't drop a column CHECK in place, so we rebuild the table without it
  // (kind stays `TEXT NOT NULL`; the connector manifest is now the source of truth
  // for valid kinds, validated in the route/registry rather than the schema). The
  // copy preserves every existing Google sync-state row verbatim — cursors,
  // enable flags, intervals, and last-status all carry over — so no resync is
  // triggered. `connector_items.kind` already had no such constraint.
  `
  CREATE TABLE connector_sync_state_new (
    account_id INTEGER NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    interval_minutes INTEGER NOT NULL DEFAULT 15,
    sync_token TEXT,
    last_synced_at TEXT,
    last_status TEXT,
    UNIQUE(account_id, kind)
  );
  INSERT INTO connector_sync_state_new
    (account_id, kind, enabled, interval_minutes, sync_token, last_synced_at, last_status)
    SELECT account_id, kind, enabled, interval_minutes, sync_token, last_synced_at, last_status
    FROM connector_sync_state;
  DROP TABLE connector_sync_state;
  ALTER TABLE connector_sync_state_new RENAME TO connector_sync_state;
  `,
  // 26 — meeting notes as auto-linked trusted sources (#26).
  //
  // A meeting note is a type='meeting' source (visibility defaults to fully
  // permissive — searchable + answerable + wiki-eligible, like a local file).
  // Its structured fields — the meeting date and the attendee list — live in a
  // companion table keyed 1:1 by the source id, so the markdown body stays on
  // `sources.content` (re-using the whole revision/chunk/extraction chain) while
  // the date/attendees are queryable on their own. Attendees are stored as a
  // JSON array of names so the UI round-trips them without a join table.
  //
  // Auto-suggested links from a meeting to existing entities (projects, people,
  // organisations, decisions) are persisted in `meeting_link_suggestions`, each
  // with a `rationale` ("why linked") and a review `status`. A suggestion is
  // unique per (source, entity); re-running extraction (reprocess) refreshes the
  // pending rows but never clobbers a user's accept/reject decision.
  `
  CREATE TABLE meeting_notes (
    source_id INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    meeting_date TEXT,
    attendees TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE meeting_link_suggestions (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    rationale TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'name',
    status TEXT NOT NULL DEFAULT 'suggested'
      CHECK (status IN ('suggested','accepted','rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_id, entity_id)
  );
  CREATE INDEX idx_meeting_links_source ON meeting_link_suggestions(source_id, status);
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

/**
 * Wipe the knowledge base back to an empty schema, in place on the live
 * connection — no file swap, so handles already held by the store/pipeline stay
 * valid. Every data table is emptied and its autoincrement counter reset; the
 * schema, triggers, and FTS5 indexes are left intact (the delete triggers keep
 * the FTS shadow tables in sync as rows go). Callers can preserve the
 * configuration that a "start from scratch" shouldn't throw away:
 *
 *   - keepSettings — the `settings` table (LLM provider, API keys, git prefs)
 *   - keepFolders  — the `watched_folders` list, so ingestion can resume
 */
export function resetDatabase(
  db: MeosDatabase,
  opts: { keepSettings?: boolean; keepFolders?: boolean } = {},
): void {
  const keep = new Set<string>();
  if (opts.keepSettings) keep.add("settings");
  if (opts.keepFolders) keep.add("watched_folders");

  // Real data tables only: skip SQLite internals and the FTS5 virtual + shadow
  // tables (those are maintained by triggers on the base tables, not directly).
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' " +
          "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'",
      )
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .filter((name) => !keep.has(name));

  // foreign_keys can't be toggled inside a transaction, so flip it off first;
  // with it off the tables can be cleared in any order.
  db.pragma("foreign_keys = OFF");
  const wipe = db.transaction(() => {
    for (const table of tables) db.exec(`DELETE FROM "${table}"`);
    const hasSequence = db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'")
      .get();
    if (hasSequence) {
      const clearSeq = db.prepare("DELETE FROM sqlite_sequence WHERE name = ?");
      for (const table of tables) clearSeq.run(table);
    }
  });
  wipe();
  db.pragma("foreign_keys = ON");
  // Reclaim the freed pages so the on-disk file actually shrinks.
  db.exec("VACUUM");
}
