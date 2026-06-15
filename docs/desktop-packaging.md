# Desktop packaging

The desktop app is a [Tauri 2](https://tauri.app) shell
([`packages/desktop`](../packages/desktop)): a native window over the same web
UI, with the Rust shell owning the server's lifecycle. No Chromium is bundled.

## Develop

```sh
pnpm build     # core + server + web dist (one-time)
pnpm desktop   # tauri dev — native window + server + UI, hot reload
```

In dev the shell runs the server straight from the repo with system `node`, so no
packaging step is needed. A `pnpm dev` server you started yourself is detected and
left untouched.

## Build a self-contained bundle

```sh
pnpm build                       # core / server / web dist
node scripts/bundle-runtime.mjs  # assemble src-tauri/payload/
pnpm desktop:build               # → src-tauri/target/release/bundle
```

[`scripts/bundle-runtime.mjs`](../scripts/bundle-runtime.mjs) assembles a
self-contained server runtime into `packages/desktop/src-tauri/payload/` (a Tauri
`bundle.resources` dir). It generates a flat `package.json` with the union of
core + server production deps, runs a clean `npm install --omit=dev` so npm builds
the correct-arch native modules, vendors the built `@meos/core`, and adds a
bundled Node runtime plus a pre-seeded embedding model so first launch works
offline.

The payload must exist before `pnpm desktop:build` (it ships as a Tauri
resource).

### Node version pin

The native modules (`better-sqlite3`, `onnxruntime-node`, `sharp`) can't be
cross-compiled, and the bundled `better-sqlite3` prebuild is ABI-bound to the
Node we ship. So the bundled Node is pinned (default `22.12.0`, override with
`MEOS_BUNDLE_NODE_VERSION`) and **the host Node's major version must match it**.

## Multi-platform CI

[`.github/workflows/desktop-build.yml`](../.github/workflows/desktop-build.yml)
runs the steps above on a matrix — each target on its own **native** runner,
since native modules can't be cross-compiled:

| Runner | Output |
|---|---|
| `macos-14` (Apple Silicon) | `.dmg` |
| `macos-15-intel` (Intel) | `.dmg` |
| `windows-latest` | `.exe` (NSIS) |
| `ubuntu-22.04` | `.AppImage` (falls back to `.deb`) |

Linux installs the WebKitGTK/AppImage system libs first. Trigger from the
**Actions** tab (*Run workflow*) or by pushing a `v*` tag, then download the
per-platform artifacts from the run summary.

## Runtime layout

The native shell health-checks `127.0.0.1:4321` on launch and, if nothing is
listening, spawns the server (bundled Node in a packaged app, system `node` in
dev) and tears it down on quit. In a packaged app the read-only bundle is
redirected to writable per-user paths via `MEOS_DATA_DIR`, `MEOS_MODEL_CACHE`,
and `MEOS_WEB_DIST`.

Builds are unsigned for now: on first open, macOS users run
`xattr -dr com.apple.quarantine /Applications/MeOS.app`; Windows users choose
*More info → Run anyway*.
