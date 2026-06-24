# @meos/contracts

The shared, runtime-agnostic API contract for meOS: Zod schemas (and their
inferred TypeScript types) for every public HTTP endpoint the server exposes,
plus the single error envelope every failure follows.

- The **server** (`@meos/server`) imports the schemas to validate requests and
  to shape (and serialize-check) responses.
- The **web client** (`@meos/web`) imports the inferred **types** so it cannot
  silently drift from the server on shape, and the runtime `ErrorCode` values so
  it can branch on typed failures.

This package depends only on `zod`, keeping the dependency graph acyclic:
`web → @meos/contracts` (types) and `server → @meos/contracts` (schemas).

## Layout

- `src/error.ts` — `ErrorEnvelopeSchema` + the `ErrorCode` enum.
- `src/schemas/<group>.ts` — request/response schemas, one file per route group:
  activity, agent-tools, calendar, chat, common, connectors, digest, git, ingest,
  intelligence, knowledge, meetings, outputs, preferences, profile, runtime,
  settings, source-health, sources, stale-facts, vault, wiki, wiki-agent.
- `src/index.ts` — namespaced re-exports (`wiki.*`, `chat.*`, …) plus the
  directly-inferred types the web client consumes.

## Rules of the road

Changes here are changes to a public interface shared by independently shipped
layers. **Additive only; never remove or rename a response field, repurpose a
field, or alter the error envelope without a major version bump.** The full
contract, the error model, and the step-by-step recipe for adding or changing an
endpoint live in [`docs/api-contracts.md`](../../docs/api-contracts.md).
