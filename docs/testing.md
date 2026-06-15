# Testing & coverage strategy

meOS uses [Vitest](https://vitest.dev) across the workspace. Tests are
**deterministic and offline by default**: no real LLM, no network. The LLM is
always a `StubLlmClient` and embeddings come from the deterministic `HashEmbedder`
(`embedding: { provider: "hash" }`), so a suite produces the same result on every
machine and in CI without any secrets.

## The layers

| Layer           | Package        | Responsibility                                                                                                                      | Run with                |
| --------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Unit**        | `@meos/core`   | Pure logic: parsing, chunking, extraction schemas, merge/contradiction rules, memory rules, retrieval, the offline ingest pipeline. | `pnpm test:unit`        |
| **Integration** | `@meos/server` | Fastify routes driven via `app.inject` against a throwaway SQLite DB and a stubbed LLM/embedder.                                    | `pnpm test:integration` |
| **e2e smoke**   | both           | The core user journeys end to end (offline): first-run, ingest a document, ask a question, open a source, save a setting.           | `pnpm test:e2e`         |

Other packages: `@meos/contracts` runs `--passWithNoTests` (schemas are exercised
through core/server); `@meos/web` carries a build-time smoke (served by the
production server in the `web-smoke` CI job); `@meos/desktop` packaging is covered
by the separate `desktop-build.yml` workflow.

## Root scripts

- `pnpm test` — every package's suite (`pnpm -r test`). The baseline gate.
- `pnpm test:unit` — core unit tests only.
- `pnpm test:integration` — server route/integration tests only.
- `pnpm test:e2e` — the two e2e smoke suites (`core/test/e2e-ingest.test.ts` +
  `server/test/e2e-smoke.test.ts`).
- `pnpm test:coverage` — runs core + server with v8 coverage and **fails if any
  package drops below its thresholds**. This is what CI enforces.

## Shared fixtures

Reusable test data lives in `packages/core/test/fixtures/index.ts` — documents,
knowledge extractions (including conflicting facts), connector deltas, source
revisions, and failed-job shapes, plus `makeExtractionStub()` /
`makeEmbedder()` factories. Both core and server suites import these (the server
via a relative path) so setup is declared once instead of per suite. The server
integration/e2e suites additionally share `packages/server/test/helpers/test-server.ts`,
which builds the real server against a temp SQLite DB.

## Coverage thresholds

Coverage is collected with the v8 provider and configured per package in its
`vitest.config.ts`. Thresholds are pinned **just below the current measured
coverage** so the gate passes today and can only be ratcheted upward — never
silently regressed. Bump them toward the live numbers as coverage improves.

| Package        | Coverage scope                                                              | Statements | Branches | Functions | Lines |
| -------------- | --------------------------------------------------------------------------- | ---------- | -------- | --------- | ----- |
| `@meos/core`   | all of `src/**`                                                             | 70%        | 58%      | 73%       | 72%   |
| `@meos/server` | tested routes + server/error plumbing, durable-ingest, runtime (see config) | 47%        | 33%      | 54%       | 47%   |

The server `include` is intentionally scoped to the surfaces the integration
suite owns, rather than all of `src` — background modules (`main.ts`, `watcher.ts`,
`scheduler.ts`, `git.ts`) that the fast PR suite deliberately does not boot would
otherwise dilute the number. As untested routes gain tests, widen the `include`
in `packages/server/vitest.config.ts` and ratchet the thresholds up.

## CI

`.github/workflows/ci.yml` runs `pnpm test` in the `build-and-test` job and then
`pnpm test:coverage`, which fails the build if thresholds aren't met. Coverage
reports (`text`/`lcov`/`html`) are written under each package's `coverage/`.
