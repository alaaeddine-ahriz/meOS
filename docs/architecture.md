# Architecture

MeOS is a local-first personal knowledge system. You feed it documents and
connected accounts; it extracts structured knowledge, maintains a compounding
knowledge base, writes a wiki it keeps rewriting, and answers questions over
your own corpus through chat. Everything runs on your machine.

This document describes the **bounded contexts** — the cohesive areas of
responsibility — and how they fit together. For "where does new code go?" and
the cross-package dependency rule, see [repo-map.md](./repo-map.md). For why the
system is shaped this way, see
[adr/0001-local-first-single-process.md](./adr/0001-local-first-single-process.md).

## Package layout

```
packages/
├── core/    domain logic, no HTTP — the bounded contexts below
├── server/  Fastify API + background workers, wires core into a running process
├── web/     React + Vite UI, talks to the server over the typed HTTP boundary
└── desktop/ Tauri 2 shell — native window + server lifecycle (Rust)
```

`@meos/core` holds all domain logic and is runtime-agnostic (no HTTP, no
process orchestration). `@meos/server` depends on `core` and turns it into a
running process: it exposes a Fastify API and runs the background workers.
`@meos/web` is a standalone SPA that reaches the server only through the typed
fetch client in `src/api.ts`. `@meos/desktop` is a thin Rust shell that owns the
native window and the server's lifecycle.

## Bounded contexts

Each context lives in `packages/core/src/<dir>` unless noted. The server adds
the process-level wiring (HTTP routes + background workers) on top.

### Ingestion — `core/src/ingest/`

Turns a file or connector item into knowledge. The pipeline:

1. **parse** (`parse.ts`) — read a document into text. Images are read by the
   LLM (OCR + description, see `extract/image.ts`); PDFs via `unpdf`, DOCX via
   `mammoth`. `SUPPORTED_EXTENSIONS` is the source of truth for what's absorbed.
2. **chunk** (`chunk.ts`) — split text into embeddable chunks.
3. **embed** — on-device vectors (see the Embeddings context).
4. **extract** — structured LLM extraction (see the Extraction context).
5. **merge** — entity resolution + contradiction check (see Knowledge store).

`pipeline.ts` (`IngestionPipeline`) orchestrates these and exposes a
`PostMergeHook` so the server can run contradiction detection after each merge.
Several documents move through the pipeline concurrently; merges are serialized.

### Extraction — `core/src/extract/`

Structured LLM extraction. `schema.ts` defines the zod `extractionSchema`
(entities, observations, relationships, relevance, sensitivity);
`extractor.ts` runs the LLM call against it; `image.ts` reads images into text.
The schema is the contract between "free-form document" and "typed knowledge".

### Knowledge store — `core/src/knowledge/` + `core/src/db/`

The compounding knowledge base: entities, relationships, and facts (observations)
with confidence.

- `db/database.ts` — opens the `better-sqlite3` database (`MeosDatabase`).
- `knowledge/store.ts` — `KnowledgeStore`, the single typed gateway to all
  persisted state (entities, observations, sources, wiki pages/runs, inbox,
  connector accounts). Most other contexts take a `KnowledgeStore`.
- `knowledge/merge.ts` — folds an `Extraction` into the store; near-duplicate
  facts reinforce confidence instead of duplicating.
- `knowledge/entity-resolution.ts` — finds duplicate entities.
- `knowledge/schema-doc.ts` — the relationship/observation vocabulary and
  sensitivity levels that govern the graph.

**Memory maintenance** lives alongside in `core/src/memory/`: contradiction
detection (`contradictions.ts`), supersession (`supersession.ts`), confidence
math (`confidence.ts`), retention/consolidation (`retention.ts`,
`consolidate.ts`), memory tiers (`memory-tiers.ts`), session crystallization
(`crystallize.ts`), and PII/secret redaction (`privacy.ts`).

### Embeddings — `core/src/embedding/`

On-device embeddings, always local regardless of LLM provider.
`embedder.ts` exposes the `Embedder` interface with a `LocalEmbedder`
(transformers.js, all-MiniLM-L6-v2) and a `HashEmbedder` for tests.
`vectors.ts` is the math: cosine similarity, serialize/deserialize, top-K, and
reciprocal rank fusion for hybrid retrieval. Vector search is brute-force cosine
over SQLite blobs — exact and fast at personal-corpus scale.

### Wiki writer — `core/src/wiki/`

Maintains the wiki agentically. `writer.ts` (`WikiWriter`) gives the model a
sandboxed copy of the wiki (`bash-tool`) with `bash`/`readFile`/`writeFile`
tools so it greps sibling pages for exact `[[wiki-link]]` names and edits the
existing page in place. `wiki-lint.ts` checks page health; `self-healing.ts`
repairs broken links. Deterministic frontmatter (confidence, counts, timestamps)
stays owned by code. Regeneration is decoupled from ingestion: stale flags
accumulate and one queued pass handles however many piled up.

### Retrieval & chat — `core/src/chat/`

Answers questions over the knowledge base only.
`retrieval.ts` (`buildContextPack`) does hybrid retrieval (vector + keyword via
RRF) into a `ContextPack`; `query-planner.ts` classifies intent; `tools.ts`
gives the chat model graph-traversal tools; `chat.ts` (`ChatService`) runs the
streaming answer loop. Answers are synthesised from the knowledge base, hedge on
weak evidence, and cite their source documents.

### Connectors — `core/src/connectors/`

A connector platform: each provider is a self-contained plugin declared by one
manifest in `framework.ts` (`id`, branding, the `kinds[]` it syncs, its `auth`
model, and the chat-agent tools it contributes). The registry (`registry.ts`,
`connectorRegistry`) is the source of truth — registering a connector injects
its private source types into `knowledge/visibility.ts` and surfaces it in every
view automatically; there is no per-provider enum to extend. Google is the
reference implementation, not the only provider.

- `framework.ts` — the manifest contract (`Connector`, kinds, `OAuthProvider`,
  the `auth` union: OAuth2 or basic credentials).
- `registry.ts` — `connectorRegistry`, the live set every other layer reads from.
- `google/` — the reference connector: REST clients + OAuth (loopback + PKCE)
  over `oauth.ts`, `people.ts` (Contacts), `calendar.ts`, `gmail.ts`, `tasks.ts`
  (read + write); contacts/calendar/gmail are read-only, tasks is read/write.
- `map/` — turn a fetched item into an `Extraction`.
- `sync.ts` — orchestrate dedup + ingest through the normal merge path.

Connectors contribute chat-agent tools via `Connector.agentTools(ctx)` +
`promptHint`; `ChatService` assembles them from the registry each turn. The raw
clients only fetch + normalize; everything reaches the graph through the same
ingestion/merge path as files. To add a provider, scaffold it with
`pnpm connector:new <id>` — see [connectors.md](./connectors.md).

### Vault — `core/src/vault/`

The user's hand-authored notes, distinct from the system-compiled wiki.
`vault.ts` (`Vault`) manages free-form Obsidian-style Markdown under
`data/vault/` that cross-links wiki entities via `[[links]]`.

### Profile — `core/src/profile/`

The _lens_ every LLM stage reads through. `profile-doc.ts` loads/saves profile
sections (work context, projects, focus rules) with version history;
`profile-assistant.ts` drafts and edits the profile from context documents or
natural-language instructions, returning a reviewable `ProfileProposal`.

### Jobs — `core/src/jobs/`

`queue.ts` provides `JobQueue` (bounded concurrency) and `SerialQueue`. These
are the primitives the server uses to bound ingest concurrency and serialize
wiki regeneration. The domain-level _building block_ is here; the _schedule and
triggers_ that drive it live in the server.

### Events & outputs — `core/src/events.ts`, `core/src/outputs.ts`

`events.ts` (`MeosEvents`) is the in-process automation bus: core stages emit
lifecycle events (contradiction, schedule, session end) and the server
subscribes. `outputs.ts` builds derived reports (contradiction report, decision
brief, dependency graph, entity timeline, meeting brief).

### LLM provider — `core/src/llm/`

One client, every provider. `ai-sdk.ts` wraps the Vercel AI SDK
(Anthropic / OpenAI / Google / local OpenAI-compatible); `stub.ts` is the
test client; `switchable.ts` (`SwitchableLlmClient`) lets Settings swap
provider/model/key at runtime; `discover.ts` lists models. Everything sits
behind a single `LlmClient` interface so tests run with no network.

## Server: process wiring — `packages/server/`

The server is the only place HTTP and process orchestration live. It depends on
`@meos/core` and assembles the contexts above into a running app.

- `context.ts` — `createContext()` is the **composition root**: it opens the DB,
  builds the `KnowledgeStore`, LLM client, embedder, `WikiWriter`, `Vault`,
  `IngestionPipeline`, queues, watcher, git sync, and `ConnectorManager`, then
  wires the event bus (contradictions, nightly schedule, session
  crystallization). Everything downstream receives this `AppContext`.
- `server.ts` + `routes/` — Fastify API. One route module per surface:
  `chat.ts`, `wiki.ts`, `ingest.ts`, `vault.ts`, `profile.ts`, `settings.ts`,
  `connectors.ts`, `connector-catalog.ts`, `activity.ts`, `digest.ts`, `git.ts`,
  `outputs.ts`. Routes are the typed boundary the web UI consumes. Connector
  endpoints are keyed by a `:provider` path param
  (`/api/connectors/:provider/...`), and `GET /api/connectors/catalog` is the
  secret-free projection the web renders its connector UI from.
- **Background workers**:
  - `watcher.ts` (`FolderWatcher`) — chokidar watch-folder ingestion, content-
    hash change detection, pushes onto the ingest queue.
  - `scheduler.ts` (`startScheduler`) — `croner` nightly consolidation/digest.
  - `connector-manager.ts` (`ConnectorManager`) — per-kind sync intervals for
    connected accounts, riding the same ingest queue.
- `git.ts` (`GitSync`) — versions the human-readable `data/` dir;
  `commit-message.ts` builds the wiki commit messages; `activity.ts`
  (`ActivityBus`) records and streams wiki-maintainer transcripts.
- `main.ts` — the entrypoint: create context, build server, start workers,
  listen on `127.0.0.1:<port>`, and shut everything down cleanly.

## Web: UI — `packages/web/`

A standalone React + Vite SPA. It reaches the server **only** through the typed
fetch client in `src/api.ts` — it never imports `@meos/core` or
`@meos/server`. The interface shapes in `api.ts` are the web side's view of the
API contract.

- `views/` — one screen per file: `ChatView`, `WikiView` / `WikiPage` /
  `GraphView`, `ActivityHub` (+ `ActivityView`, `ChangesView`,
  `ContradictionsView`, `DigestView`), `VaultView`, `SettingsView`,
  `ProfileSection`.
- `components/` — shared UI: `ui/` (shadcn primitives), `ai-elements/` (chat
  components), the `tiptap-*` editor stack, `ForceGraph`, `CommandPalette`,
  `DiffView`, `SourceList`, `Markdown`, `Page`.
- `hooks/`, `lib/` — UI state, theme, wiki-link parsing, datetime, platform
  (desktop vs browser) helpers.

## Desktop: shell — `packages/desktop/`

A Tauri 2 Rust shell (`src-tauri/src/main.rs`) that owns a native window over
the same web UI and manages the server's **lifecycle only** — no domain logic.
On launch it health-checks `127.0.0.1:4321` and spawns the server if nothing is
listening (the bundled Node in a packaged app, system `node` in dev), tearing it
down on quit. A self-started `pnpm dev` server is detected and left untouched.
In a packaged app the read-only bundle is redirected to writable per-user paths
via `MEOS_DATA_DIR` / `MEOS_MODEL_CACHE` / `MEOS_WEB_DIST`.

## Sync — git versioning of `data/`

Sync is not a package; it's the `GitSync` worker (`server/src/git.ts`) plus the
git routes (`server/src/routes/git.ts`) and the Settings → Sync UI. It versions
the human-readable knowledge — wiki pages, digests, and notes (Markdown under
`data/`) — as a Git repository rooted at `data/`. The SQLite database is
deliberately `.gitignore`d: it is derived state rebuilt from watched files,
whereas the Markdown is the portable artifact worth backing up. Auth flows
through the user's normal git setup.

## End-to-end flow

```
file / connector item
   └─ ingest: parse → chunk → embed → extract → merge ──┐
                                                        ├─ KnowledgeStore (SQLite)
   contradiction check (post-merge hook) ───────────────┘        │
                                                                 │ stale flags
   wiki writer (decoupled, coalesced regen) ─────────────────────┘
                                                                 │
   GitSync commits the Markdown ─────────────────────────────────┘

chat: question → retrieval (hybrid) → context pack → LLM → cited answer
```

All of this runs in one process (the server), exposed over HTTP to the web UI,
optionally wrapped by the desktop shell.
