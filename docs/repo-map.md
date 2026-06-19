# Repo map — where does new code go?

A practical guide for finding the right home for new code. For the bigger
picture, read [architecture.md](./architecture.md) first.

The monorepo is a pnpm workspace with four packages:

| Package                              | What it is                                                             |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `@meos/core` (`packages/core`)       | Domain logic, runtime-agnostic. No HTTP, no process orchestration.     |
| `@meos/server` (`packages/server`)   | Fastify API + background workers. Wires `core` into a running process. |
| `@meos/web` (`packages/web`)         | React + Vite SPA. Talks to the server over a typed HTTP boundary.      |
| `@meos/desktop` (`packages/desktop`) | Tauri 2 Rust shell. Owns the native window and server lifecycle.       |

## Where does new code go?

### A new connector (e.g. Microsoft, CalDAV)

Connectors are self-contained plugins, so most of this is generated and the rest
is one manifest — no per-provider edits to the server, the routes, or the UI.

1. **Scaffold** with `pnpm connector:new <id>` — it creates the provider folder
   beside `google/`, registers the connector in `connectors/registry.ts`, and
   stubs a brand logo.
2. **Domain** in `core/src/connectors/<id>/`. Fill in the manifest in the
   connector's `framework.ts` declaration (id, branding, the `kinds[]` it syncs,
   the `auth` model — OAuth2 or basic credentials), implement `fetchDelta` to
   pull + normalize each changed item, and add a mapper under `map/` that turns an
   item into an `Extraction`. The registry — not a `types.ts` enum — is the source
   of truth: registering injects the connector's catalog entry, privacy defaults,
   sync schedule, routes, and any `agentTools`.
3. **No server or UI wiring needed.** `ConnectorManager` drives sync from the
   registry, the `:provider`-keyed routes in `server/src/routes/connectors.ts`
   serve every connector, and the web reads the secret-free
   `GET /api/connectors/catalog` projection — only the brand SVG is a manual
   frontend artifact. See [`connectors.md`](./connectors.md).

### An ingestion parser (e.g. a new file type)

1. Add parsing in `core/src/ingest/parse.ts` and register the extension in
   `SUPPORTED_EXTENSIONS`. Non-text formats (images) go through
   `core/src/extract/image.ts`.
2. No server change needed for plain file types — `FolderWatcher`
   (`server/src/watcher.ts`) already picks up anything in `SUPPORTED_EXTENSIONS`.
3. If the UI lists supported types, update copy in `web/`.

### A UI page

1. Add a view in `web/src/views/`, wire its route in `web/src/App.tsx`, and add
   a command-palette entry in `web/src/components/CommandPalette.tsx`.
2. Any new data it needs: add typed functions + interfaces to
   `web/src/api.ts` (never reach into the server directly).
3. Add the matching endpoint in `server/src/routes/`.

### A background job

1. The reusable primitive (`JobQueue` / `SerialQueue`) lives in
   `core/src/jobs/queue.ts` — reuse it, don't reinvent it.
2. The **schedule and triggers** belong in the server: a recurring job goes in
   `server/src/scheduler.ts`; an event-driven one subscribes to `MeosEvents` in
   `server/src/context.ts`; a folder-driven one extends
   `server/src/watcher.ts`. Push work onto the appropriate queue from
   `context.ts` so concurrency stays bounded and merges serialize.

### A desktop capability (window, lifecycle, native integration)

1. `packages/desktop/src-tauri/src/main.rs` and the Tauri config. Keep it to
   shell/lifecycle concerns (window, server spawn/teardown, per-user paths).
   No domain logic — that belongs in `core`/`server`.
2. If the web UI needs to detect desktop vs browser, use
   `web/src/lib/platform.ts`.

### A new domain capability (extraction rule, memory policy, retrieval tweak)

It almost always belongs in `core/src/`, in the matching bounded context
(`extract/`, `memory/`, `knowledge/`, `chat/`, `wiki/`, …). Export anything the
server needs from `core/src/index.ts` — that barrel is `core`'s public API.

## Package ownership table

| Package         | Responsibility                                                                                                                                                                     | Allowed dependencies                                                                                           | Forbidden dependencies                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@meos/core`    | All domain logic: ingestion, extraction, knowledge store, memory, embeddings, wiki writer, chat/retrieval, connectors, vault, profile, jobs, LLM client. Runtime-agnostic.         | Third-party libs (`ai`, `zod`, `better-sqlite3`, `@huggingface/transformers`, `bash-tool`, …). Node built-ins. | `@meos/server`, `@meos/web`, `@meos/desktop`. No HTTP framework. No process orchestration (watch/cron/spawn). |
| `@meos/server`  | Fastify API (`routes/`), composition root (`context.ts`), background workers (watcher, scheduler, connector-manager), git sync, activity bus. Turns `core` into a running process. | `@meos/core` (via its public barrel `core/src/index.ts`), Fastify, `chokidar`, `croner`, Node built-ins.       | `@meos/web`, `@meos/desktop`. Deep imports into `core` internals (e.g. `@meos/core/src/...`).                 |
| `@meos/web`     | React + Vite SPA: views, components, hooks. The only consumer of the API contract, via the typed fetch client `src/api.ts`.                                                        | The server's HTTP API through `src/api.ts`. React, Vite, UI libs, Tauri JS plugins.                            | `@meos/core`, `@meos/server` (no source imports — talk over HTTP only). Server internals.                     |
| `@meos/desktop` | Tauri 2 Rust shell: native window + server lifecycle (spawn/health-check/teardown, per-user paths).                                                                                | Tauri, the built web UI and server bundle as resources.                                                        | Any domain logic. Importing `core`/`server`/`web` source.                                                     |

## The cross-package dependency rule

The layering is one-directional and the boundaries are public APIs, not
internals:

- **`core` is domain/runtime-agnostic.** It knows nothing about HTTP, the web
  UI, or the desktop shell. It must not import from any other `@meos/*` package.
- **`server` may depend on `core`** — and only `core`. It consumes `core`
  through the public barrel (`core/src/index.ts`); it does not reach into
  `core`'s internal files.
- **`web` uses the typed API/client boundary, not server internals.** All
  server communication goes through `web/src/api.ts` (HTTP `fetch`). The web
  package imports no `@meos/*` source.
- **`desktop` owns shell/lifecycle only.** It manages the window and the
  server process; it contains no domain logic and imports no other package's
  source (it consumes the built server/web as bundled resources).
- **No deep imports across package public APIs.** Depend on a package's public
  surface (`@meos/core`'s `index.ts` barrel; the server's HTTP routes), never
  on a path inside another package (`@meos/core/src/knowledge/store.js`).

In short: `desktop → (spawns) server → core`, and `web → (HTTP) → server`.
Dependencies point inward toward `core`; nothing points back out.
