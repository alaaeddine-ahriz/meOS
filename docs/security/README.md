# Security: supply-chain & vulnerability handling

This document describes how meOS keeps its dependencies and code safe, and how
to respond when a vulnerability is found. It covers the automation wired into
CI, the process for handling vulnerable dependencies and emergency updates,
secret-scanning guidance, and the `.env.example` policy.

## Automation overview

| Concern                             | Tooling                                 | Where                        |
| ----------------------------------- | --------------------------------------- | ---------------------------- |
| Automatic dependency update PRs     | Dependabot (npm, github-actions, cargo) | `.github/dependabot.yml`     |
| PR quality gates                    | GitHub Actions                          | `.github/workflows/ci.yml`   |
| Release dependency inventory (SBOM) | Syft (`anchore/sbom-action`)            | `.github/workflows/sbom.yml` |
| Local audit                         | `pnpm audit` / `pnpm licenses`          | root `package.json` scripts  |

### Dependabot

Proposes updates weekly across all three ecosystems meOS ships:

- **npm** — the pnpm workspace, globbed across the repo root and every
  `packages/*` package. Minor/patch bumps are grouped into one PR; majors are
  separate so breaking changes get individual review.
- **github-actions** — keeps CI action versions current.
- **cargo** — the Tauri desktop crate at `packages/desktop/src-tauri`.

Open-PR limits keep the queue manageable.

### CI quality gates

`ci.yml` runs on every PR and on pushes to `main` (Node 22). Four jobs, wired as
required status checks on the default branch:

- **build-and-test** — `pnpm build` → `pnpm typecheck` → `pnpm test` →
  `pnpm test:coverage` (coverage thresholds fail the build if they regress).
- **lint** — `pnpm lint` (ESLint) + `pnpm format:check` (Prettier).
- **boundaries** — `pnpm boundaries` (dependency-cruiser) enforces the
  package-import rules.
- **web-smoke** — boots the built server with `MEOS_LLM_PROVIDER=stub` and
  asserts `/api/health` is ok and `/` serves the SPA.

These catch correctness, style, and architecture drift before merge. There is no
CodeQL / dependency-review / OpenSSF Scorecard workflow today; enabling GitHub's
native code scanning and secret scanning (see below) is recommended.

### SBOM (release artifacts)

On `v*` tags (mirroring `desktop-build.yml`), Syft generates an **SPDX-JSON**
SBOM covering the resolved npm and cargo dependency trees. The SBOM is uploaded
as a build artifact and attached to the GitHub release as `meos-sbom.spdx.json`.
Diffing SBOMs across releases reveals newly introduced or vulnerable components.

## Handling vulnerable dependencies

### Routine (non-urgent)

1. Dependabot opens an update PR. The CI gates (build, test, typecheck, lint,
   boundaries) run against it automatically.
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
   review. The CI gates must pass.
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
