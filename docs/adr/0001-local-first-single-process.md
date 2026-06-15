# 1. Local-first, mostly single-process, with explicit boundaries

## Status

Accepted.

## Context

MeOS is a personal second brain: it ingests a person's documents and connected
accounts, maintains a compounding knowledge base, writes a wiki it keeps
rewriting, and answers questions over that corpus. The data is inherently
private — someone's whole working life — and the value proposition is that
*your data stays yours*.

The naïve "scale-out" instinct would split this into services: an ingestion
worker, a vector database, a separate LLM gateway, a job broker, a sync service,
each in its own process or container, coordinated over the network. For a
single-user personal tool, that architecture buys complexity (deployment,
service discovery, network failure modes, multi-process state) and costs the
two things that actually matter here: privacy and zero-friction local operation.

Two forces are in tension:

- **Simplicity / privacy / offline.** The product should run on one machine,
  start with `pnpm dev` or a double-click, work offline, and never send data
  anywhere the user didn't choose. That argues for the smallest possible number
  of moving parts.
- **Maintainability as the system grows.** Ingestion, knowledge maintenance,
  wiki writing, retrieval/chat, connectors, and sync are genuinely distinct
  concerns. Collapsing them into an undifferentiated blob would make the code
  unmaintainable even if the deployment is simple.

## Decision

**MeOS stays local-first and runs as essentially a single process, while
keeping strict architectural boundaries in the code.**

Concretely:

1. **Single process at runtime.** One Fastify server process hosts the API and
   all background work — watch-folder ingestion, the cron scheduler, connector
   sync, and decoupled wiki regeneration — coordinated by in-process queues
   (`JobQueue`) and an in-process event bus (`MeosEvents`). `server/src/context.ts`
   is the composition root that wires it all together. There is no external
   broker, no separate worker tier, no network hop between stages.

2. **On-device by default.** Storage is in-process `better-sqlite3`. Embeddings
   always run locally (transformers.js). Vector search is brute-force cosine
   over SQLite blobs — exact and fast at personal-corpus scale, and one less
   dependency. The only outbound calls are to the LLM provider the user
   explicitly configures, and even that can be a local OpenAI-compatible server.

3. **The desktop shell owns lifecycle, not logic.** Tauri spawns/health-checks/
   tears down the one server process; it contains no domain logic. Packaging
   bundles a private Node runtime and a pre-seeded embedding model so the app
   launches offline with nothing installed.

4. **Boundaries are enforced in code, not by process isolation.** Even though
   everything runs in one process, the packages form a one-directional
   dependency graph: `desktop → server → core`, and `web → (HTTP) → server`.
   `core` is domain logic with no HTTP and no knowledge of the other packages;
   `server` depends only on `core`'s public barrel; `web` talks to the server
   only through the typed `api.ts` fetch client; no deep imports cross package
   public APIs. See [../repo-map.md](../repo-map.md) for the full rule.

This gives us the boundaries a service-oriented design would give — the contexts
are separable and independently testable — without paying the operational tax of
actually running them as separate services.

## Consequences

**Positive**

- Trivial to run and ship: start one process, or double-click one app. Works
  offline; nothing leaves the machine unless the user configures a remote LLM or
  git remote.
- Privacy is structural, not a policy: data lives in `data/` (Markdown +
  SQLite) on the user's disk.
- Fast inner loop: no network hops between ingestion stages; tests run with no
  LLM and no network because everything sits behind in-process interfaces
  (`LlmClient`, `Embedder`, `KnowledgeStore`).
- The explicit package boundaries keep the codebase navigable and let any
  context be refactored or extracted later without a rewrite.

**Negative / trade-offs**

- Single-machine, single-user by design. There's no built-in multi-user server
  or horizontal scaling; that would be a different product.
- In-process queues mean heavy work (LLM extraction, wiki regeneration) shares
  the server's resources; concurrency is bounded deliberately (`JobQueue`) to
  keep the machine responsive.
- Brute-force vector search is fine at personal scale but is not designed for
  corpora orders of magnitude larger.
- The boundaries rely on convention and review (the dependency rule in
  repo-map.md) rather than being enforced by separate runtimes, so they must be
  upheld in code review.

**If these constraints ever stop holding** (e.g. a genuine need for multi-user
or out-of-process scaling), the maintained boundaries are exactly what make a
future split feasible: each bounded context already talks through an explicit
interface, so promoting one to its own process is a contained change rather than
a rewrite.
