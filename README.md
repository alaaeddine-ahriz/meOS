# MeOS

A personal second brain: capture everything, organise nothing. An LLM ingests what you feed it, maintains a compounding knowledge base (entities, relationships, facts with confidence), writes a wiki you never edit, and answers questions about your own life and work through chat.

## Quick start

```sh
pnpm install
pnpm dev
```

Open <http://localhost:5173>, then open **Settings (⌘,)** and pick an LLM provider — paste your API key and choose a model there. (Exporting `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` before launch works too, as a fallback.) The API server runs on `:4321`; the Vite dev server proxies `/api` to it.

For a production build served from one process:

```sh
pnpm build
node packages/server/dist/main.js     # serves API + UI on :4321
```

## Run in a container

Prefer not to install Node and native build tools? Start the server + web dev
loop in a Node 22 container with one command:

```sh
pnpm dev:container
```

Then open <http://localhost:5173>. This is the non-desktop path — the Tauri
desktop build, Rust toolchain, and Linux WebKit deps stay host-native. See
[`docker/README.md`](docker/README.md) for the smoke check and details.

### Desktop app (Tauri)

Prerequisites:

- The [Rust toolchain](https://rustup.rs) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`, then `source "$HOME/.cargo/env"`.
- **Linux only:** Tauri's native webview needs WebKitGTK and related system libraries. On Debian/Ubuntu (incl. WSL2):

  ```sh
  sudo apt update && sudo apt install -y build-essential curl wget file pkg-config \
    libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
    libwebkit2gtk-4.1-dev libsoup-3.0-dev
  ```

  (On WSL2 the window renders through WSLg, which ships with Windows 11.) macOS and Windows need no extra system packages beyond Rust.

**Develop** against a live window with hot reload:

```sh
pnpm install
pnpm build       # builds @meos/core, the server bundle, and the web UI (one-time)
pnpm desktop     # native window + server + UI
```

In dev the shell runs the server straight from the repo, so no packaging is
needed — the empty `src-tauri/payload/` dir (kept via `.gitkeep`) only has to
exist for Tauri's resource step; it's populated for real by `bundle-runtime.mjs`
in the distributable build below.

**Build a distributable, self-contained app.** This bundles a private Node
runtime, the server, the web UI, and a pre-seeded embedding model into the app,
so it launches offline with nothing installed:

```sh
pnpm build                       # produce core / server / web dist
node scripts/bundle-runtime.mjs  # assemble packages/desktop/src-tauri/payload/
pnpm desktop:build               # → packages/desktop/src-tauri/target/release/bundle
```

The payload's native modules (`better-sqlite3`, `onnxruntime-node`, `sharp`)
can't be cross-compiled, so `bundle-runtime.mjs` builds them for the host and
pins the bundled Node version — **the host Node's major version must match it**
(default 22.x; override with `MEOS_BUNDLE_NODE_VERSION`). The payload ships as a
Tauri resource, so it must exist before `pnpm desktop:build`.

**Release packages for every platform** are built in CI:
`.github/workflows/desktop-build.yml` runs the steps above on a macOS (Apple
Silicon + Intel) / Windows / Linux matrix — each on its own native runner — and
uploads a `.dmg` / `.exe` / `.AppImage` per platform. Trigger it from the
**Actions** tab (_Run workflow_) or by pushing a `v*` tag, then download the
artifacts from the run summary. Builds are unsigned for now: on first open,
macOS users run `xattr -dr com.apple.quarantine /Applications/MeOS.app`, Windows
users choose _More info → Run anyway_.

The native shell owns the server's lifecycle: on launch it health-checks
`127.0.0.1:4321` and, if nothing is listening, spawns the server (the bundled
Node in a packaged app, system `node` in dev) and tears it down on quit — even
if the shell is killed, the server notices the orphaning and exits on its own. A
dev server you started yourself (`pnpm dev`) is detected and left untouched, so
you get hot reload while the window points at it. The LLM provider and API key
are configured in Settings, so no environment is needed. In a packaged app the
read-only bundle is redirected to writable per-user paths via `MEOS_DATA_DIR`,
`MEOS_MODEL_CACHE`, and `MEOS_WEB_DIST`; dev overrides are `MEOS_PORT`,
`MEOS_SERVER_ENTRY`, and `MEOS_ROOT`.

## Using it

- **Chat (home, ⌘1)** — ask "What do I know about X?". Answers are synthesised from your knowledge base only, hedge on weak evidence, and say so when the knowledge base can't answer. Each answer lists the source documents it drew on; wiki pages do the same — in the desktop app, clicking a source reveals the original file in Finder.
- **Notes (⌘2)** — a hand-authored, Obsidian-style Markdown editor with `[[wiki-link]]` / `@`-mention autocomplete that cross-links your notes to wiki entities. Unlike ingested sources, these notes are yours to write: they live as plain `.md` files under `data/vault/` and are versioned with the rest of your knowledge.
- **Wiki (⌘3)** — pages per person / project / organisation / concept / place / decision, written and continuously rewritten by the LLM from accumulated facts. You never edit them. Toggle the **Graph** view for a force-directed map of every entity and the relationships between them, coloured by type — pan, zoom, hover to trace a node's connections, and click any node to open its page.
- **Activity (⌘4)** — the oversight hub, in three tabs:
  - **Feed** — a live timeline of documents landing and the wiki-maintainer rewriting pages in response, streaming the agent's reasoning and edits as they happen. One row per file, updated in place as it changes (_ingested_ → _updated_).
  - **Review** — likely duplicates and contradicting claims queued for your decision.
  - **Digest** — a sub-two-minute briefing of what changed: new knowledge, superseded facts, contradictions needing attention. Generated by the nightly consolidation (03:00 by default) or on demand with _Run consolidation_.
- **Connectors (Settings → Connectors)** — sync a Google account (read-only) so the people, meetings, and correspondence in your life become knowledge automatically: **Contacts** (People API) turn into person entities with their details, **Calendar** events become entities linking the people you met with, and **Gmail** metadata maps who you correspond with. OAuth is loopback + PKCE against your _own_ Google Cloud "Desktop app" client, so tokens never pass through anyone else; each kind syncs on its own interval (incremental — sync tokens / history IDs, not full re-pulls). Contact details and email metadata stay private (searchable, but kept out of the git-synced wiki).
- **Profile (Settings → Profile)** — define who you are, your work context, key projects, and focus rules. This becomes the _lens_ every LLM stage reads through: extraction, wiki writing, chat, and digests prioritise your world instead of generic facts. Upload context documents (onboarding doc, project overview, mission brief) or edit in natural language ("add that I'm focused on local-first AI tools") and MeOS proposes an update you review as a diff before applying. Profile documents stay private to this machine by default (never git-synced unless you opt in), every edit is audited, and each section keeps a restorable version history.
- **Settings (⌘,)** — pick the folders MeOS should watch (native folder picker in the desktop app), choose light / dark / system appearance, and pick the LLM provider (Anthropic, OpenAI, Google, or a local OpenAI-compatible server like LM Studio — paste an API key or point at a local endpoint, choose a model; applies immediately, no restart). Everything readable in watched folders (`.md .txt .csv .json .org .pdf .docx .png .jpg .gif .webp`) is absorbed automatically — new files and edits alike, across restarts. Change detection is content-based: a fast mtime + size check backed by a SHA-256 content hash, so each distinct version of a file is processed exactly once and a metadata-only touch (cloud re-download, backup restore) is skipped without re-running the LLM. Images are read by the LLM (text transcribed, content described) and absorbed like any note. Your files are never moved or modified.
- **⌘K** — jump to any view or wiki page from the keyboard.

## Configuration

The LLM provider, model, and API key are defined in **Settings** only (persisted in `data/meos.db`) — Anthropic (default), OpenAI, Google, or a local OpenAI-compatible server (LM Studio, llama.cpp, Ollama's `/v1`) for fully local operation — point at its endpoint (e.g. `http://localhost:1234/v1`), no API key, nothing leaves the machine. Environment keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) act as fallbacks when no key was pasted in Settings; `MEOS_LLM_PROVIDER` overrides the provider per-run.

`meos.config.json` at the repo root holds infrastructure config only (all fields optional; defaults shown there). Notable:

- `consolidation.cron`: when nightly maintenance runs.

Embeddings always run on-device (transformers.js, all-MiniLM-L6-v2 — downloaded once to the local cache), regardless of provider.

## Your data stays yours

Everything lives in `data/` in portable formats: wiki pages, digests, and your hand-written notes are plain Markdown files (`data/wiki/`, `data/digests/`, `data/vault/`); the knowledge graph, sources, and conversations are a standard SQLite database (`data/meos.db`). Nothing requires MeOS to read.

**Git sync** (Settings → _Sync_) versions the human-readable knowledge as a Git repository rooted at `data/`: enable it to make the first commit, optionally point an `origin` remote at GitHub, and _Sync now_ (or _Auto-sync nightly_) to commit-pull-push the markdown. The SQLite database is deliberately `.gitignore`d — it is derived state rebuilt from your watched files, whereas the wiki, digests, and notes are the portable artifact worth backing up. Auth flows through your normal git setup (SSH agent, credential helper, or a token in the remote URL).

## Architecture

A pnpm monorepo of four packages: `core` (runtime-agnostic domain logic — ingestion, knowledge store, extraction, memory, wiki writer, retrieval/chat, connectors, vault), `server` (Fastify API + background workers that wire `core` into one local process), `web` (React + Vite UI that talks to the server over a typed HTTP boundary), and `desktop` (a Tauri 2 shell owning the native window and server lifecycle). MeOS runs local-first and essentially single-process, with strict one-directional package boundaries (`desktop → server → core`, `web → HTTP → server`). Tests run without any LLM or network: `pnpm test` (LLM calls are stubbed behind the `LlmClient` interface).

For the full picture, see:

- [`docs/architecture.md`](docs/architecture.md) — the bounded contexts (ingestion, knowledge store, retrieval/chat, wiki writer, connectors, vault, desktop shell, sync) and how they fit together.
- [`docs/repo-map.md`](docs/repo-map.md) — where new code goes, the package ownership table, and the cross-package dependency rule.
- [`docs/adr/0001-local-first-single-process.md`](docs/adr/0001-local-first-single-process.md) — why MeOS stays local-first and mostly single-process.

## Dependencies, deliberately

| Dependency                                                                                                                                          | Why                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ai` (Vercel AI SDK) + `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/google` (the OpenAI client also drives any local OpenAI-compatible server) | One client, every provider — unified completion / structured-output / streaming / tool-use behind a single `LlmClient` |
| `bash-tool` + `just-bash`                                                                                                                           | In-memory sandbox + bash/file tools that let the wiki writer search and edit pages agentically                         |
| `@huggingface/transformers`                                                                                                                         | On-device embeddings — privacy + offline by construction                                                               |
| `better-sqlite3`                                                                                                                                    | Synchronous, in-process, standard-format storage                                                                       |
| `fastify` + `@fastify/multipart` + `@fastify/static`                                                                                                | HTTP API, uploads, serving the built UI                                                                                |
| `zod`                                                                                                                                               | One schema language for LLM structured outputs and validation                                                          |
| `chokidar`                                                                                                                                          | Watch-folder ingestion                                                                                                 |
| `croner`                                                                                                                                            | Nightly consolidation schedule                                                                                         |
| `unpdf`, `mammoth`                                                                                                                                  | PDF / DOCX text extraction                                                                                             |
| `react`, `react-router-dom`, `react-markdown`, `tailwindcss`, `vite`                                                                                | The web UI                                                                                                             |
| shadcn/ui + Vercel ai-elements (vendored into `src/components/`)                                                                                    | Accessible primitives and chat components, owned as source — no runtime UI dependency                                  |
| `streamdown`                                                                                                                                        | Markdown rendering tuned for incomplete, still-streaming chat output                                                   |
| `tauri` (Rust)                                                                                                                                      | Desktop shell — native window over the same web UI, ~no Chromium bundled                                               |
| Fontsource packages                                                                                                                                 | Fonts bundled locally — no CDN calls                                                                                   |

Vector search is brute-force cosine over SQLite blobs: at personal-corpus scale this is fast, exact, and one less dependency.
