# Data model

MeOS is local-first. All state lives in `data/`: human-readable artifacts are
plain Markdown (`data/wiki/`, `data/digests/`, `data/vault/`), and the knowledge
graph plus operational state is a single SQLite database (`data/meos.db`). The
DB is `.gitignore`d — it is derived state, rebuildable from your watched files.

Schema and migrations live in
[`packages/core/src/db/database.ts`](../packages/core/src/db/database.ts);
queries are in
[`packages/core/src/knowledge/store.ts`](../packages/core/src/knowledge/store.ts).
Migrations are forward-only, tracked by SQLite's `user_version`.

## Core tables

| Table | Purpose |
|---|---|
| `sources` | Every ingested document (watched file, upload, connector item). Holds title, path, mime, content. |
| `chunks` | Embedded text segments of a source (`embedding` BLOB), with a `chunks_fts` FTS5 index for BM25. |
| `entities` | The graph nodes: `person`, `project`, `organisation`, `concept`, `place`, `decision`. Have a unique `slug` and `entity_aliases`. |
| `observations` | Atomic claims about an entity. Carry confidence, status (`active`/`superseded`/`contradicted`), provenance, and a `sensitivity` tier. |
| `relationships` | Typed edges between entities, with confidence, status, and per-source provenance. |
| `wiki_pages` | The compiled per-entity Markdown `body` (+ embedding, quality score), indexed by `wiki_fts`. |

## Provenance & confidence

An observation is backed by every document that supports it via
`observation_sources`; confidence is a function of that source count rather than
an ad-hoc bump. New knowledge supersedes old (`superseded_by`) instead of being
silently overwritten, and conflicts are recorded in `contradictions`.
Relationships follow the same lifecycle via `relationship_sources`.

Observations also carry a richer claim shape: a `kind`, the exact `source_quote`
and its `char_start`/`char_end` span, a `valid_from`/`valid_until` window, and a
`memory_tier` (`working` / `episodic` / `semantic` / `procedural`) reclassified
as evidence accumulates.

## Retrieval

Vector search is brute-force cosine over the SQLite `embedding` BLOBs — exact and
fast at personal-corpus scale. FTS5 (`chunks_fts`, `observations_fts`,
`wiki_fts`) adds BM25 keyword ranking; the two are fused with reciprocal rank
fusion at query time.

## Operational tables

`inbox_items` (file-centric ingest feed), `ingested_files` (mtime/size +
content-hash ledger for change detection), `conversations`/`messages`/
`message_sources` (chat + citations), `digests`, `settings` (LLM provider, keys,
git prefs), `audit_log`, `wiki_runs`/`wiki_run_events` (agentic writer
transcripts), and the `connector_*` tables (see
[`connectors.md`](connectors.md)).

## Sensitivity

Observations have a `sensitivity` of `normal`, `private`, or `secret`. The wiki
and other portable artifacts only see `normal` claims, enforced once in
`store.visibleObservations()`. See [`privacy.md`](privacy.md).
