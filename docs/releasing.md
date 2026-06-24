# Releasing MeOS

This document is the release policy for MeOS: how we version, tag, build, and
ship the desktop app, and what to verify before each release. It is the
authority referenced from [`CHANGELOG.md`](../CHANGELOG.md).

## Versioning (SemVer)

MeOS follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html):
`MAJOR.MINOR.PATCH`.

- **MAJOR** — incompatible changes. For MeOS this primarily means a change that
  an existing database cannot survive cleanly (see
  [Database migrations & compatibility](#database-migrations--compatibility)),
  removal of a connector, or a breaking change to on-disk layout.
- **MINOR** — new functionality added in a backward-compatible way: new
  features, new connectors, additive forward-only DB migrations.
- **PATCH** — backward-compatible bug fixes only.

While MeOS is pre-1.0 (`0.y.z`), the public surface is still settling: minor
versions may include larger changes and the `0.MINOR` bump is used liberally for
feature work. Treat the project as not yet API-stable until `1.0.0`.

The version of record lives in three places that **must be kept in sync** for a
release:

- root [`package.json`](../package.json) → `version`
- [`packages/desktop/src-tauri/tauri.conf.json`](../packages/desktop/src-tauri/tauri.conf.json) → `version`
- the new heading in [`CHANGELOG.md`](../CHANGELOG.md)

[Release Please](#automated-releases-release-please) keeps these three in sync
automatically (the manifest in
[`.release-please-manifest.json`](../.release-please-manifest.json) tracks the
last released version), so you normally don't edit them by hand.

## Tag convention

Releases are tagged **`vX.Y.Z`** (e.g. `v0.1.0`). Normally
[Release Please](#automated-releases-release-please) creates this tag for you
when the Release PR is merged (`include-component-in-tag: false` +
release-type `node` yields the `v`-prefixed tag). The same form matches the
`v*` push trigger in
[`.github/workflows/desktop-build.yml`](../.github/workflows/desktop-build.yml)
and [`sbom.yml`](../.github/workflows/sbom.yml), which is the
[manual fallback](#manual-fallback):

```sh
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

The leading `v` is required (the workflow trigger is `v*`). Tag the exact commit
that the changelog entry describes.

## Branch workflow

- `main` is always releasable. Feature and fix work happens on short-lived
  branches (`feat/...`, `fix/...`, `chore/...`) and merges into `main` via PR
  using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
  `fix:`, `docs:`, `chore:`, …). The commit type is what
  [Release Please](#automated-releases-release-please) uses to compute the next
  version and to slot each change into the changelog.
- Releases are **automated and two-step** — see
  [Automated releases](#automated-releases-release-please) below. You no longer
  hand-edit the version or the `## [Unreleased]` section for a release; Release
  Please maintains them from commit history.
- We do not maintain long-lived release branches. If a patch is needed for an
  older release, branch from that release's tag, fix forward, and let Release
  Please cut a new patch version.

## Automated releases (Release Please)

Releases are driven by
[`googleapis/release-please-action`](https://github.com/googleapis/release-please-action)
via [`.github/workflows/release-please.yml`](../.github/workflows/release-please.yml).
Publication stays **manual and reviewable**: nothing ships until a human merges
the generated Release PR. The flow has two steps.

**Step 1 — prepare (the Release PR).** On every push to `main` (and on manual
`workflow_dispatch`), Release Please opens or updates a single **Release PR**
titled `chore(main): release X.Y.Z`. That PR:

- bumps `version` in [`package.json`](../package.json) and (via `extra-files` in
  [`release-please-config.json`](../release-please-config.json))
  [`packages/desktop/src-tauri/tauri.conf.json`](../packages/desktop/src-tauri/tauri.conf.json),
- moves the pending Conventional Commits into a new `## [X.Y.Z] - DATE` section
  of [`CHANGELOG.md`](../CHANGELOG.md) and refreshes the compare/release links,
- computes the next version from commit types (`feat` → minor, `fix` → patch,
  `feat!`/`BREAKING CHANGE` → major; pre-1.0 still increments the `0.MINOR`).

This Release PR **is** the review gate. Review the proposed version and
changelog, run through the [Release checklist](#release-checklist), and edit the
PR if needed (e.g. add a **Database migrations** risk note — Release Please does
not generate that subsection, so add it by hand to the new version's entry).

**Step 2 — publish (merge the Release PR).** Merging the Release PR triggers
`release-please.yml` again. Release Please then:

- creates the **GitHub Release** and the annotated **`vX.Y.Z` tag**, and
- because `release_created == true`, the workflow builds the desktop bundles
  (by calling [`desktop-build.yml`](../.github/workflows/desktop-build.yml) as a
  reusable workflow) and **attaches the installers to that GitHub Release**.

> Note: tags pushed by a workflow using the default `GITHUB_TOKEN` do not
> trigger other workflows (GitHub's recursion guard), so `release-please.yml`
> invokes the desktop build directly rather than relying on the `v*` tag push.
> The `v*` push trigger on `desktop-build.yml` / `sbom.yml` is still there for
> manual tags.

State for the tool lives in two committed files — do not hand-edit them except
to correct a mistake:

- [`release-please-config.json`](../release-please-config.json) — release type
  (`node`), the `extra-files` that bump `tauri.conf.json`, and the
  commit-type → changelog-section mapping.
- [`.release-please-manifest.json`](../.release-please-manifest.json) — the last
  released version (`"."`: `"X.Y.Z"`), which Release Please reads and updates.

### Manual fallback

If you ever need to cut a release without the automation, the old manual path
still works: edit the changelog/version by hand, then push a `vX.Y.Z` tag — the
`v*` trigger on `desktop-build.yml` builds and attaches the artifacts.

## Release checklist

Run through this while reviewing the Release PR, before merging it (or, for the
[manual fallback](#manual-fallback), before pushing a release tag).

- [ ] **Toolchain matches.** `pnpm --version` is `10.20.0` (pinned via
      `packageManager` in `package.json`) and Node matches `.nvmrc` (`22`).
      Run `corepack enable` so the pinned pnpm is used automatically.
- [ ] **Clean install resolves.** `pnpm install --frozen-lockfile` succeeds.
- [ ] **Build + typecheck pass.** `pnpm build && pnpm typecheck` are green.
- [ ] **Tests pass.** `pnpm test`.
- [ ] **Desktop packaging works.** Either let CI build it from the tag, or build
      locally for the host: `node scripts/bundle-runtime.mjs` then
      `pnpm desktop:build`. Confirm the payload verification step passes
      (better-sqlite3 `.node`, bundled Node, server/web builds, seeded model).
- [ ] **DB migration smoke test.** Open a database created by the _previous_
      release and confirm it upgrades cleanly to the new schema version (the
      migration runner in
      [`packages/core/src/db/database.ts`](../packages/core/src/db/database.ts)
      applies migrations `user_version` → `migrations.length` in a transaction).
      Then open a fresh database and confirm it initialises. Record the new
      schema version and any migration risk in the changelog's
      **Database migrations** subsection.
- [ ] **Data-backup warning.** Because migrations are forward-only and cannot be
      undone (see below), the release notes for any release that adds a
      migration **must** tell users to back up their database **before**
      upgrading. The DB lives in the app's data directory; copying that file
      while the app is closed is a sufficient backup.
- [ ] **Dependency audit.** Run `pnpm audit` (and review native-module updates —
      better-sqlite3, onnxruntime-node, sharp — since their ABI is bound to the
      bundled Node). Note anything notable under known issues.
- [ ] **Known issues.** List unresolved bugs / limitations in the changelog
      entry so users know what to expect before installing.
- [ ] **Versions in sync.** `package.json`, `tauri.conf.json`, and the changelog
      heading all show the same `X.Y.Z`.
- [ ] **Changelog finalised.** `## [Unreleased]` moved to `## [X.Y.Z] - DATE`,
      links updated.

## Desktop artifacts

CI builds one artifact bundle per platform on a native runner (native modules
can't be cross-compiled). The matrix and outputs come from
[`.github/workflows/desktop-build.yml`](../.github/workflows/desktop-build.yml);
the product name is **`MeOS`** and the version is taken from `tauri.conf.json`.

On a real release these bundles are **attached to the GitHub Release** (via
`gh release upload`) so users download installers from the Release page. They
are _also_ kept as per-run workflow artifacts (named `meos-<os>`) for
debugging. A plain `workflow_dispatch` run with no release tag only produces the
workflow artifacts.

| Platform              | Runner           | Bundle                   | Artifact (uploaded as `meos-<os>`)                                    |
| --------------------- | ---------------- | ------------------------ | --------------------------------------------------------------------- |
| macOS (Apple Silicon) | `macos-14`       | DMG                      | `MeOS_<version>_aarch64.dmg`                                          |
| Windows               | `windows-latest` | NSIS                     | `MeOS_<version>_x64-setup.exe`                                        |
| Linux                 | `ubuntu-22.04`   | AppImage (fallback: DEB) | `MeOS_<version>_amd64.AppImage` (fallback `MeOS_<version>_amd64.deb`) |

Notes on the naming convention (these are Tauri's standard bundle names — keep
them as-is so they stay predictable):

- **DMG / NSIS / AppImage / DEB** are Tauri's default per-bundle outputs.
- The Linux job tries **AppImage** first and falls back to a **DEB** package if
  `linuxdeploy` fails on the GitHub runner; a release may therefore ship either
  one for Linux. The upload glob in the workflow accepts `*.dmg`, `*.exe`,
  `*.AppImage`, and `*.deb`.
- The CI **upload artifact name** is `meos-<os>` (e.g. `meos-macos-14`); the
  files _inside_ it use the Tauri names above.
- Arch tokens follow Tauri/platform conventions: macOS uses `aarch64` / `x64`,
  Debian/AppImage use `amd64` for x86-64.
- Nothing is code-signed yet (see [Future hardening](#future-hardening)).

## Database migrations & compatibility

The schema is versioned by SQLite's `user_version` pragma and driven by an
ordered, **forward-only** list of migrations in
[`packages/core/src/db/database.ts`](../packages/core/src/db/database.ts). On
open, the runner applies every migration from the database's current
`user_version` up to `migrations.length`, each inside its own transaction.

Compatibility rules:

- **Upgrades are automatic and forward-only.** Adding a migration is a backward-
  compatible (MINOR) change for _new_ installs and for users moving forward.
- **There is no downgrade path.** Once a database is upgraded, an older app
  build will see a `user_version` higher than it understands and will not
  re-apply or roll back. Reinstalling an older version against an upgraded
  database is unsupported and may fail or corrupt data.
- **Mitigation:** the release checklist requires a data-backup warning in the
  notes for any release that adds a migration. The only reliable "downgrade" is
  to restore the pre-upgrade database backup and reinstall the older app.
- **Never edit a shipped migration** (it has already run on users' machines).
  Always append a new entry to the list; that increment is the new schema
  version. Document each new migration in the changelog's **Database
  migrations** subsection, including any risk (e.g. data rewrites, `NOT NULL`
  backfills) so users can judge upgrade risk before installing.

## Tooling: pinned versions

- **pnpm** is pinned via `"packageManager": "pnpm@10.20.0"` in the root
  `package.json`. With Corepack enabled (`corepack enable`), contributors and CI
  automatically use the exact pnpm version, keeping `pnpm-lock.yaml` stable.
- **Node** is pinned to `22` in [`.nvmrc`](../.nvmrc). Run `nvm use` to match.
  The workspace requires Node `>=22 <23` (root `package.json` `engines`,
  enforced by `engine-strict` in `.npmrc`), and the desktop build in particular
  **must** run on Node **22**: the runtime bundler
  ([`scripts/bundle-runtime.mjs`](../scripts/bundle-runtime.mjs)) ships Node
  `22.12.0` and `better-sqlite3`'s prebuilt binary is ABI-bound to that major
  version. The script aborts if the host Node major differs from the bundled
  one, and CI's `setup-node` is pinned to `22` for the same reason.

## Release process: Release Please (not Changesets)

MeOS automates releases with
[Release Please](#automated-releases-release-please) rather than
[Changesets](https://github.com/changesets/changesets):

- MeOS is effectively a **single shippable product** (a desktop app). The
  internal packages (`@meos/core`, `@meos/server`, `@meos/web`,
  `@meos/desktop`) are not published to npm and version together, so
  Changesets' main value — independent per-package versioning and automated npm
  publishing — does not apply. Release Please is configured as a **single
  release** for the repo root (`release-type: node`) and bumps the desktop
  `tauri.conf.json` alongside it via `extra-files`.
- Release Please derives the next version and the changelog from **Conventional
  Commits**, so there are no extra changeset fragment files to write — the
  source of truth is the commit history we already keep.
- Publication remains a **deliberate two-step**: the generated Release PR is the
  review gate, and merging it is the explicit "ship" action. We still keep the
  hand-authored **Database migrations** risk subsection by editing the Release
  PR before merging (Release Please does not generate it).

If the project later starts publishing packages independently, revisit
Changesets.

## Future hardening

- **Code signing & notarization.** Desktop artifacts are currently **unsigned**
  (the build workflow notes this explicitly). Users will see OS warnings on
  first launch (Gatekeeper on macOS, SmartScreen on Windows). Signing the macOS
  DMG + notarizing it, and signing the Windows installer, is planned future work
  and should be added to the release checklist once certificates are in place.
- **Update channel / auto-update** (e.g. Tauri updater) is not yet wired up;
  releases are installed manually from the artifacts.
