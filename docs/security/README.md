# Security: supply-chain & vulnerability handling

This document describes how meOS keeps its dependencies and code safe, and how
to respond when a vulnerability is found. It covers the automation wired into
CI, the process for handling vulnerable dependencies and emergency updates,
secret-scanning guidance, and the `.env.example` policy.

## Automation overview

| Concern                             | Tooling                                 | Where                                     |
| ----------------------------------- | --------------------------------------- | ----------------------------------------- |
| Automatic dependency update PRs     | Dependabot (npm, github-actions, cargo) | `.github/dependabot.yml`                  |
| Static analysis (JS/TS + Rust)      | CodeQL                                  | `.github/workflows/codeql.yml`            |
| PR dependency / license / vuln gate | `actions/dependency-review-action`      | `.github/workflows/dependency-review.yml` |
| Repo posture scoring                | OpenSSF Scorecard                       | `.github/workflows/scorecard.yml`         |
| Release dependency inventory (SBOM) | Syft (`anchore/sbom-action`)            | `.github/workflows/sbom.yml`              |
| Local audit                         | `pnpm audit` / `pnpm licenses`          | root `package.json` scripts               |

### Dependabot

Proposes updates weekly across all three ecosystems meOS ships:

- **npm** — the pnpm workspace, globbed across the repo root and every
  `packages/*` package. Minor/patch bumps are grouped into one PR; majors are
  separate so breaking changes get individual review.
- **github-actions** — keeps CI action versions current.
- **cargo** — the Tauri desktop crate at `packages/desktop/src-tauri`.

Open-PR limits keep the queue manageable.

### CodeQL

Runs on PRs to `main`, pushes to `main`, and weekly. The language matrix:

- **javascript-typescript** — analyzed with `build-mode: none` (CodeQL reads
  source directly; no install/build required, so the job stays fast).
- **rust** — analyzed with `build-mode: manual`. We compile **only** the
  `packages/desktop/src-tauri` crate with `cargo build` rather than running a
  full Tauri build.

> **Rust CodeQL scope decision.** A full Tauri build pulls in heavy system
> WebKitGTK / AppIndicator dependencies and a frontend bundling step that add
> flakiness without improving the Rust analysis surface. We therefore install
> the minimal WebKitGTK dev libs (matching `desktop-build.yml`) and build only
> the crate. If the Rust job ever becomes a maintenance burden on hosted
> runners, it is acceptable to narrow it to a scheduled-only run or drop the
> Rust language from the matrix; the JS/TS analysis must always remain.

### Dependency review

On every PR to `main`, `dependency-review-action` inspects newly added
dependencies and **fails on any high-or-worse advisory**. It also flags
copyleft / non-permissive licenses (`GPL-*`, `AGPL-*`, `LGPL-*`) for review and
posts a summary comment on the PR.

### OpenSSF Scorecard

Runs weekly and on pushes to `main`, scoring the repository's supply-chain
posture (branch protection, pinned dependencies, token permissions, etc.) and
uploading SARIF to the Security tab.

### SBOM (release artifacts)

On `v*` tags (mirroring `desktop-build.yml`), Syft generates an **SPDX-JSON**
SBOM covering the resolved npm and cargo dependency trees. The SBOM is uploaded
as a build artifact and attached to the GitHub release as `meos-sbom.spdx.json`.
Diffing SBOMs across releases reveals newly introduced or vulnerable components.

## Handling vulnerable dependencies

### Routine (non-urgent)

1. Dependabot opens an update PR. CI (CodeQL + dependency review) runs against
   it automatically.
2. Review the changelog/diff, confirm CI is green, and merge.
3. For anything Dependabot can't auto-resolve, run the local audit:

   ```sh
   pnpm audit --prod          # or: pnpm run audit
   pnpm licenses list --prod  # or: pnpm run audit:licenses
   ```

   `pnpm audit` may report pre-existing advisories — that is expected and does
   not, by itself, block unrelated work. Track and prioritize them below.

### Triage / prioritization

- **Critical / High, reachable in production code** → fix immediately
  (emergency process below).
- **Moderate** → schedule within the normal update cadence.
- **Low / dev-only / unreachable** → document and batch with routine updates.

When no fixed version exists, consider: an `overrides`/`pnpm.overrides` pin to a
patched transitive version, swapping the dependency, or temporarily removing the
affected feature.

### Emergency updates

For an actively exploited or critical advisory:

1. Branch from `main` (e.g. `security/<advisory-id>`).
2. Apply the minimal version bump or override needed to remediate.
3. Run `pnpm install`, `pnpm build`, `pnpm typecheck`, and `pnpm audit --prod`
   to confirm the fix and no regression.
4. Open a PR titled `security:` referencing the advisory; request expedited
   review. CI gates (CodeQL, dependency review) must pass.
5. After merge, cut a patch release tag (`vX.Y.Z`) so the SBOM and desktop
   build refresh with the remediated dependency.

## Reporting a vulnerability

Report suspected vulnerabilities **privately** — do not open a public issue.
Use GitHub's private vulnerability reporting (Security ▸ Report a vulnerability)
on the repository. Include affected version, reproduction steps, and impact.
Maintainers will acknowledge, assess severity, and coordinate a fix and
disclosure timeline.

## Secret-scanning guidance

- Enable **GitHub secret scanning** and **push protection** in repository
  settings so committed credentials are detected (and pushes blocked) early.
- Never hard-code API keys or tokens. meOS reads provider keys from environment
  variables or stored app config — see `.env.example` and
  `packages/server/src/routes/settings.ts`.
- If a secret is ever committed: **rotate it immediately**, then purge it from
  history. Rotation is the real fix — assume anything pushed is compromised.
- Keep real secrets out of CI logs; use GitHub Actions secrets, never plaintext.

## `.env.example` policy

- `.env.example` is the **single source of truth** for the environment variables
  meOS reads. It contains **placeholders and comments only — never real
  secrets**.
- Real values live in a local `.env`, which is git-ignored (see `.gitignore`).
- When code starts reading a new `process.env.*` variable, add it to
  `.env.example` (with a comment and placeholder) in the same change, so the
  documented surface stays accurate.
