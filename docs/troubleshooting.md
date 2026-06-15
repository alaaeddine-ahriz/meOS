# Troubleshooting

## Setup

**`pnpm dev` fails before the UI loads.** `pnpm dev` builds `@meos/core` first;
if that fails, the server and web never start. Run `pnpm build` and read the
`@meos/core` tsc output.

**The UI loads but every action errors / "no provider".** No LLM provider is
configured. Open **Settings (⌘,)**, pick a provider and paste a key, or export
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` before launch. See
[`llm-providers.md`](llm-providers.md).

**Port already in use.** The API server uses `:4321` and Vite uses `:5173`. Stop
the other process, or set `MEOS_PORT` for the server.

**First run downloads a model.** Embeddings use a local `all-MiniLM-L6-v2`
model fetched once to the cache; the first ingest waits on that download. It's
cached afterwards (and pre-seeded in packaged desktop builds).

## Ingestion

**A file isn't being absorbed.** Only readable types are ingested
(`.md .txt .csv .json .org .pdf .docx .png .jpg .gif .webp`) and only inside a
folder you added in Settings. Change detection is content-based (mtime + size,
confirmed by a SHA-256 hash), so a metadata-only touch is intentionally skipped.

**Wiki pages look empty or stale.** Wiki regeneration runs decoupled in the
background after ingestion; give the Activity → Feed a moment. A page only shows
`normal` observations (see [`privacy.md`](privacy.md)).

## Connectors

**OAuth won't complete.** Connectors use loopback + PKCE against _your own_
Google Cloud "Desktop app" client. Make sure you created a Desktop-app OAuth
client and entered its credentials. See [`connectors.md`](connectors.md).

**A connector stopped syncing / 410 errors.** An expired Google sync token (410
GONE) triggers a full resync automatically; the next run rebuilds the cursor.

## Desktop build

**`pnpm desktop:build` errors about a missing payload.** Run
`node scripts/bundle-runtime.mjs` first — the payload ships as a Tauri resource
and must exist before bundling.

**Native module / ABI mismatch when packaging.** The bundled Node is pinned to
22.x and `better-sqlite3` is ABI-bound to it; your host Node's major version must
match (override with `MEOS_BUNDLE_NODE_VERSION`). See
[`desktop-packaging.md`](desktop-packaging.md).

**Linux bundling fails.** Install the WebKitGTK/AppImage system libs (see the
list in `.github/workflows/desktop-build.yml`); CI falls back to a `.deb` when
the AppImage step fails.

**App won't open after install.** Builds are unsigned. macOS:
`xattr -dr com.apple.quarantine /Applications/MeOS.app`. Windows: _More info →
Run anyway_.

## Tests

**A test hits the network.** It shouldn't — provider calls are stubbed behind
`LlmClient`. If a new test needs the network, it's testing the wrong layer.
