# 2. SQLite as the local store

Status: Accepted

## Context

MeOS is a single-user, local-first app. It needs to store a knowledge graph
(entities, observations, relationships), source documents, chunk + observation
embeddings, conversations, and operational state — and run both keyword and
vector search over it. There is no server tier and no multi-user concurrency to
coordinate; the store must be embeddable, portable, and easy to back up.

## Decision

Use a single SQLite database (`data/meos.db`) via `better-sqlite3` as the entire
operational store. Schema evolves through forward-only migrations tracked by
SQLite's `user_version` (`packages/core/src/db/database.ts`). Vector search is
brute-force cosine over embedding BLOBs stored in the same DB; keyword search uses
SQLite's built-in FTS5 (BM25), and the two are fused with reciprocal rank fusion.

## Consequences

- One file, standard format — trivial backup, inspection, and "nothing requires
  MeOS to read it."
- `better-sqlite3` is synchronous and in-process: simple call sites, no pool, no
  network round-trips. The trade-off is a native module that can't be
  cross-compiled (see desktop packaging).
- No separate vector database or search service: one less dependency. Brute-force
  cosine is exact and fast at personal-corpus scale, but is O(n) per query and
  would need an ANN index at much larger scale.
- The DB is derived state and is `.gitignore`d; portable artifacts are the
  Markdown files, not the DB.
