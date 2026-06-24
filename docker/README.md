# Run meOS in a container

This is the **non-desktop** path: it runs the API server and the web dev loop
inside a single Node 22 container, so a contributor can boot the app without
installing Node, pnpm, or native build tools on the host.

**Prerequisite:** [Docker](https://docs.docker.com/get-docker/) (Docker Desktop,
or Docker Engine with the Compose v2 plugin). `pnpm dev:container` is just a
shortcut for the `docker compose` command below; to avoid installing pnpm on the
host, run that `docker compose` command directly.

```sh
pnpm dev:container
# equivalent to:
# docker compose -f docker/docker-compose.dev.yml up
```

Then open <http://localhost:5173>. Open **Settings (⌘,)** to pick an LLM
provider and paste an API key (or export `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` / `GEMINI_API_KEY` before `pnpm dev:container` — they are
passed through to the container).

What it does, mirroring the local `pnpm dev` flow:

- **Node 22** base image (`node:22-bookworm`) — matches the version pinned by
  the desktop runtime bundle. The full (non-slim) image is buildpack-deps based,
  so it ships `gcc`/`g++`/`make`/`python`; the native deps listed in
  `pnpm-workspace.yaml`'s `onlyBuiltDependencies` (`better-sqlite3`, `sharp`,
  `@huggingface/transformers`/onnxruntime, `esbuild`, `protobufjs`) compile
  inside the container. No host build tools required.
- Activates **pnpm via corepack**, runs `pnpm install`, then `pnpm dev` (which
  builds `@meos/core`, then runs core + server + web in parallel).
- Exposes the **server on `:4321`** and the **web Vite dev server on `:5173`**.
  Vite proxies `/api` to the server; `MEOS_DEV_HOST=true` makes it bind to all
  interfaces so the host can reach it.
- Mounts the **repo** (for hot reload) and the **`data/` dir** explicitly, so
  the SQLite database (`data/meos.db`) and the wiki/vault/digests are visible on
  the host and easy to dispose of. `MEOS_DATA_DIR=/workspace/data` points the
  server there.
- Keeps `node_modules` in **container-owned volumes** so the Linux-built native
  modules are not shadowed by a host (macOS/Windows) install bind-mounted over
  them.

To wipe state and start clean:

```sh
docker compose -f docker/docker-compose.dev.yml down -v   # drops node_modules + pnpm store volumes
rm -rf data/meos.db*                                       # drops the SQLite database
```

## Smoke check

With the container up:

1. **API health** — through the web dev server's `/api` proxy:

   ```sh
   curl http://localhost:5173/api/health
   # => {"ok":true,"llmProvider":"anthropic"}
   ```

   (The server itself listens on loopback inside the container; the proxy on
   `:5173` is the host-reachable entry point. The server `:4321` port is also
   published for convenience.)

2. **Web UI served** — open <http://localhost:5173> and confirm the app loads.

3. **SQLite data dir mounted** — after the app starts, the database appears on
   the host:

   ```sh
   ls data/meos.db
   ```

## What stays host-native (NOT in the container)

The container covers only the server + web dev loop. The desktop app is
deliberately **not** containerized:

- The **Tauri desktop build** (`pnpm desktop`, `pnpm desktop:build`).
- The **Rust toolchain** (rustup/cargo).
- The **Linux WebKit / GTK system deps** Tauri needs for a native window.

These remain on the host and do not interfere with — and are not affected by —
the container dev loop. Use the native flow in the root [`README.md`](../README.md)
for desktop work. The local-first desktop workflow is unchanged whether or not
you ever start a container.
