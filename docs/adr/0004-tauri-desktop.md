# 4. Tauri for the desktop shell

Status: Accepted

## Context

MeOS should ship as a friendly desktop app that launches offline with nothing
installed, while reusing the existing web UI and Fastify server rather than a
second implementation. The app also needs native-only abilities (folder pickers,
reveal-in-Finder) and a managed server lifecycle.

## Decision

Use Tauri 2 (Rust shell) as the desktop wrapper
(`packages/desktop`). The shell renders the same web UI in the platform WebView
and owns the server's lifecycle: it health-checks `127.0.0.1:4321`, spawns the
server if nothing is listening, and tears it down on quit. A self-contained
payload (bundled Node runtime, server, web UI, pre-seeded embedding model) is
assembled by `scripts/bundle-runtime.mjs` and shipped as a Tauri resource.

## Consequences

- Uses the OS WebView instead of bundling Chromium — small binaries, one UI
  codebase shared with the web build.
- A dev server you started (`pnpm dev`) is detected and left untouched, so hot
  reload still works while the window points at it.
- Native modules (`better-sqlite3`, `onnxruntime-node`, `sharp`) can't be
  cross-compiled, so release builds run on a per-platform native CI matrix and
  the bundled Node version is pinned (see `0002` and desktop packaging).
- Requires the Rust toolchain to build, and platform WebKit deps on Linux.
- Builds are currently unsigned, so users clear quarantine / SmartScreen on first
  open.
