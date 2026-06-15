# Changelog

All notable changes to MeOS are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

See [docs/releasing.md](docs/releasing.md) for the release policy, tagging
convention, and the per-release checklist.

## [Unreleased]

### Added

- _Nothing yet._

### Changed

- _Nothing yet._

### Fixed

- _Nothing yet._

### Database migrations

- _No new migrations since the last release._ Migrations are forward-only;
  see [docs/releasing.md](docs/releasing.md#database-migrations--compatibility).

## [0.1.0] - 2026-06-15

Initial release of MeOS: a local-first LLM wiki that turns your documents into a
typed knowledge graph with an agentic wiki and chat over your own corpus.

### Added

- **Knowledge core** (`@meos/core`): SQLite-backed store with a forward-only
  migration system (schema versions 1–17), entities, typed relationships,
  observations with provenance and confidence, contradictions, and memory tiers
  (working / episodic / semantic / procedural).
- **Hybrid retrieval**: FTS5 (BM25) keyword ranking fused with vector search via
  reciprocal rank fusion; a pre-seeded `Xenova/all-MiniLM-L6-v2` embedding model
  so first launch works offline.
- **Agentic wiki**: per-entity wiki pages with quality scoring, staleness
  tracking, git-backed change history, and replayable maintainer run transcripts.
- **Ingestion**: document import, user-configured watch folders with a
  content-hash ledger that skips unchanged files, and a file-centric Inbox feed.
- **External connectors**: Google Contacts, Calendar, and Gmail sync with
  per-kind sync cursors and a content-hash dedup ledger.
- **Chat** (`@meos/server`, `@meos/web`): conversational interface over the
  compiled knowledge base with per-message source citations that survive reload.
- **Governance**: append-only audit log, human-gated deduplication, and
  sensitivity tiers that keep private claims out of the wiki.
- **Desktop app** (`@meos/desktop`): Tauri shell bundling a self-contained Node
  runtime, native modules (better-sqlite3, onnxruntime-node, sharp), the built
  server/web, and the pre-seeded embedding model. CI packages per platform via
  [`.github/workflows/desktop-build.yml`](.github/workflows/desktop-build.yml).

### Database migrations

- Ships schema versions 1 through 17. As the first release there is no upgrade
  path from an earlier version; a fresh database is created on first launch.
  Migrations are forward-only — see
  [docs/releasing.md](docs/releasing.md#database-migrations--compatibility).

[Unreleased]: https://github.com/alaaeddine-ahriz/meOS/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alaaeddine-ahriz/meOS/releases/tag/v0.1.0
