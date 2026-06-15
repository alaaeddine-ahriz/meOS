# Contributing to MeOS

Thanks for helping build MeOS. This guide gets you from a clean checkout to a
green build and an open PR. For what each part of the system does, see
[`docs/`](docs/).

## Prerequisites

- **Node** ≥ 20 (the desktop runtime is pinned to Node 22.x — see below).
- **pnpm** 10 (the repo is a pnpm workspace; `corepack enable` will provide it).

## Native (web) development

```sh
pnpm install
pnpm dev
```

`pnpm dev` builds `@meos/core` once, then runs core (watch), the Fastify server,
and the Vite web UI in parallel. Open <http://localhost:5173>; the Vite dev
server proxies `/api` to the API server on `:4321`.

Pick an LLM provider in **Settings (⌘,)** and paste an API key, or export
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` before launch as a
fallback. See [`docs/llm-providers.md`](docs/llm-providers.md).

## Desktop development (Tauri)

Prerequisites:

- The [Rust toolchain](https://rustup.rs) (stable).
- **Linux** also needs the system WebKit/AppImage libraries —
  `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
  `libxdo-dev`, `libssl-dev`, `patchelf`, `libfuse2` (see the exact list in
  `.github/workflows/desktop-build.yml`). macOS and Windows need no extra system
  libraries beyond Rust.

```sh
pnpm install
pnpm build       # build core, server bundle, and web UI once
pnpm desktop     # native window + server + UI, hot reload
```

To produce a self-contained, offline-capable bundle, see
[`docs/desktop-packaging.md`](docs/desktop-packaging.md). The bundled Node
runtime is pinned to 22.x, so a local packaging build needs the host Node's
major version to match.

## Test and verify

```sh
pnpm test        # vitest across packages; LLM + network are stubbed
pnpm typecheck   # tsc --noEmit across packages
pnpm build       # tsc + vite build across packages
```

Tests never call a real LLM or the network — provider calls are stubbed behind
the `LlmClient` interface, so the suite is deterministic and offline.

## Branch & PR workflow

- Branch off `main`; never commit to `main` directly. Use a descriptive prefix,
  e.g. `feat/…`, `fix/…`, `docs/…`.
- **One PR per issue.** Keep PRs focused; if a change grows, split it.
- Use conventional-ish commit subjects: `feat(connectors): …`,
  `fix(wiki): …`, `docs: …`.
- Before opening a PR, make sure `pnpm typecheck`, `pnpm test`, and `pnpm build`
  pass.
- Open the PR with `gh pr create`, reference the issue (`Closes #N`), and fill
  out the PR template.

## Coding conventions

- **Strict TypeScript.** `strict` and `noUncheckedIndexedAccess` are on
  (`tsconfig.base.json`). Don't loosen them; fix the types.
- **No deep cross-package imports.** Depend on a sibling package through its
  public entry (`@meos/core`), never by reaching into its `src/`. The dependency
  direction is `web`/`server` → `core`; `core` has no HTTP and no UI deps.
- **`core` stays runtime-agnostic.** Domain logic, the knowledge store,
  extraction, the wiki writer, connectors, and embeddings live in `core` with no
  Fastify/React imports.
- Match the surrounding style; let the compiler and existing patterns guide you
  rather than reformatting unrelated code.

## Architecture decisions

Significant technical choices are recorded as ADRs under
[`docs/adr/`](docs/adr/). When you make a decision with lasting consequences,
add an ADR following the existing Status / Context / Decision / Consequences
format.
