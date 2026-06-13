# MeOS

A personal second brain: capture everything, organise nothing. An LLM ingests what you feed it, maintains a compounding knowledge base (entities, relationships, facts with confidence), writes a wiki you never edit, and answers questions about your own life and work through chat.

This implements **Phases 1 + 2** of the [intent document](./MeOS_Intent_Document.docx): the working core (ingestion → memory → wiki → chat) plus self-maintaining memory (confidence decay, supersession, contradiction detection, nightly consolidation, daily digest).

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

### Desktop app (Tauri)

Prerequisites: the [Rust toolchain](https://rustup.rs).

**Develop** against a live window with hot reload:

```sh
pnpm install
pnpm build       # builds @meos/core, the server bundle, and the web UI (one-time)
pnpm desktop     # native window + server + UI
```

In dev the shell runs the server straight from the repo, so no packaging is
needed.

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
**Actions** tab (*Run workflow*) or by pushing a `v*` tag, then download the
artifacts from the run summary. Builds are unsigned for now: on first open,
macOS users run `xattr -dr com.apple.quarantine /Applications/MeOS.app`, Windows
users choose *More info → Run anyway*.

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

- **Capture (⌘J)** — jot a thought from anywhere in the app; MeOS files it in the background.
- **Profile (Settings → Profile)** — define who you are, your work context, key projects, and focus rules. This becomes the *lens* every LLM stage reads through: extraction, wiki writing, chat, and digests prioritise your world instead of generic facts. Upload context documents (onboarding doc, project overview, mission brief) or edit in natural language ("add that I'm focused on local-first AI tools") and MeOS proposes an update you review as a diff before applying. Profile documents stay private to this machine by default (never git-synced unless you opt in), every edit is audited, and each section keeps a restorable version history.
- **Settings (⌘,)** — pick the folders MeOS should watch (native folder picker in the desktop app), choose light / dark / system appearance, and pick the LLM provider (Anthropic, OpenAI, Google, or a local OpenAI-compatible server like LM Studio — paste an API key or point at a local endpoint, choose a model; applies immediately, no restart). Everything readable in watched folders (`.md .txt .csv .json .org .pdf .docx .png .jpg .gif .webp`) is absorbed automatically — new files and edits alike, across restarts, exactly once per file version. Images are read by the LLM (text transcribed, content described) and absorbed like any note. Your files are never moved or modified.
- **Inbox** — what came in: each item's processing status and what the system learned from it.
- **Wiki** — pages per person / project / organisation / concept / place / decision, written and continuously rewritten by the LLM from accumulated facts. You never edit them.
- **Graph (⌘3)** — a force-directed map of every entity and the relationships between them, coloured by type. Pan, zoom, hover to trace a node's connections, and click any node to open its wiki page.
- **Chat** (home, ⌘1) — ask "What do I know about X?". Answers are synthesised from your knowledge base only, hedge on weak evidence, and say so when the knowledge base can't answer. Each answer lists the source documents it drew on; wiki pages do the same — in the desktop app, clicking a source reveals the original file in Finder.
- **Digest** — a sub-two-minute briefing of what changed: new knowledge, superseded facts, contradictions needing your attention. Generated by the nightly consolidation (03:00 by default) or on demand with *Run consolidation*.
- **⌘K** — jump to any view or wiki page from the keyboard.

## Configuration

The LLM provider, model, and API key are defined in **Settings** only (persisted in `data/meos.db`) — Anthropic (default), OpenAI, Google, or a local OpenAI-compatible server (LM Studio, llama.cpp, Ollama's `/v1`) for fully local operation — point at its endpoint (e.g. `http://localhost:1234/v1`), no API key, nothing leaves the machine. Environment keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) act as fallbacks when no key was pasted in Settings; `MEOS_LLM_PROVIDER` overrides the provider per-run.

`meos.config.json` at the repo root holds infrastructure config only (all fields optional; defaults shown there). Notable:

- `consolidation.cron`: when nightly maintenance runs.

Embeddings always run on-device (transformers.js, all-MiniLM-L6-v2 — downloaded once to the local cache), regardless of provider.

## Your data stays yours

Everything lives in `data/` in portable formats: wiki pages and digests are plain Markdown files (`data/wiki/`, `data/digests/`); the knowledge graph, sources, and conversations are a standard SQLite database (`data/meos.db`). Nothing requires MeOS to read.

**Git sync** (Settings → *Sync*) versions the human-readable knowledge as a Git repository rooted at `data/`: enable it to make the first commit, optionally point an `origin` remote at GitHub, and *Sync now* (or *Auto-sync nightly*) to commit-pull-push the markdown. The SQLite database is deliberately `.gitignore`d — it is derived state rebuilt from your watched files, whereas the wiki and digests are the portable artifact worth backing up. Auth flows through your normal git setup (SSH agent, credential helper, or a token in the remote URL).

## Architecture

```
packages/
├── core/    domain logic, no HTTP — ingestion pipeline, knowledge store,
│            extraction, agentic wiki writer, memory maintenance, LLM (Vercel
│            AI SDK: Anthropic / OpenAI / Google / local OpenAI-compatible / test stub) +
│            on-device embeddings
├── server/  Fastify API, background job queue, watch folder, cron scheduler,
│            git sync of the data dir
├── web/     React + Vite UI (chat, wiki, graph, inbox, digest) — shadcn/ui + ai-elements
└── desktop/ Tauri 2 shell: native window + server lifecycle (Rust)
```

The ingestion pipeline: parse (images are read by the LLM: OCR + description) → chunk + embed (locally) → structured LLM extraction → entity resolution & merge (near-duplicate facts reinforce confidence instead of duplicating) → contradiction check (supersede or flag, never silently keep). Several documents move through this concurrently (merges are serialized), and wiki regeneration runs decoupled in the background — a batch of files triggers one coalesced regen pass, a few pages at a time in parallel, instead of one pass per file.

Wiki pages are maintained agentically: each regeneration gives the model a sandboxed copy of the wiki (via `bash-tool`) with `bash`/`readFile`/`writeFile` tools, so it greps sibling pages for exact `[[wiki-link]]` names and **edits the existing page in place** — merging new facts into prose that's still accurate rather than rewriting every page from scratch. The deterministic frontmatter (confidence, counts, timestamps) stays owned by code.

Tests run without any LLM or network: `pnpm test` (LLM calls are stubbed behind the `LlmClient` interface).

## Dependencies, deliberately

| Dependency | Why |
|---|---|
| `ai` (Vercel AI SDK) + `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/google` (the OpenAI client also drives any local OpenAI-compatible server) | One client, every provider — unified completion / structured-output / streaming / tool-use behind a single `LlmClient` |
| `bash-tool` + `just-bash` | In-memory sandbox + bash/file tools that let the wiki writer search and edit pages agentically |
| `@huggingface/transformers` | On-device embeddings — privacy + offline by construction |
| `better-sqlite3` | Synchronous, in-process, standard-format storage |
| `fastify` + `@fastify/multipart` + `@fastify/static` | HTTP API, uploads, serving the built UI |
| `zod` | One schema language for LLM structured outputs and validation |
| `chokidar` | Watch-folder ingestion |
| `croner` | Nightly consolidation schedule |
| `unpdf`, `mammoth` | PDF / DOCX text extraction |
| `react`, `react-router-dom`, `react-markdown`, `tailwindcss`, `vite` | The web UI |
| shadcn/ui + Vercel ai-elements (vendored into `src/components/`) | Accessible primitives and chat components, owned as source — no runtime UI dependency |
| `streamdown` | Markdown rendering tuned for incomplete, still-streaming chat output |
| `tauri` (Rust) | Desktop shell — native window over the same web UI, ~no Chromium bundled |
| Fontsource packages | Fonts bundled locally — no CDN calls |

Vector search is brute-force cosine over SQLite blobs: at personal-corpus scale this is fast, exact, and one less dependency.
