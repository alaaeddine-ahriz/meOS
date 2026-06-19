# Connector framework / SDK

A **connector** is meOS's product primitive for an external integration (Google,
and, by this same interface, Notion / IMAP / a local folder / …). It is a
self-contained plugin that declares, in one **manifest**, who it is, the data
**kinds** it syncs, its **auth model**, and the **agent tools** it gives the chat
assistant. Everything downstream is _derived_ from that manifest — the catalog the
web app renders from, the per-kind privacy defaults, the sync schedule, the routes —
so a new connector **appears in every view automatically** and never edits the
orchestrator (`sync.ts`, `connector-manager.ts`) or the routes.

It is also the boundary between a provider's API and the ingestion pipeline: the
connector pulls a delta and **normalizes** each changed item; the orchestrator
persists and **materializes** it. Neither side reaches across that line.

## The pieces

| File                    | Role                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `framework.ts`          | The `Connector` interface: `ConnectorManifest`, `KindManifest`, `AuthManifest`, `OAuthProvider`, `NormalizedItem`, `AgentToolContext`.                                                                                       |
| `registry.ts`           | `ConnectorRegistry` — look up by id, and the derivation surface (`list`, `sourceTypes`, `privateSourceTypes`). `connectorRegistry` ships with Google registered; `register()` also injects the connector's privacy defaults. |
| `google/connector.ts`   | `GoogleConnector` — the reference implementation (sync + agent tools + OAuth).                                                                                                                                               |
| `sync.ts`               | The provider-agnostic orchestrator (`syncConnector`, `ensureAccessToken`).                                                                                                                                                   |
| `template.connector.ts` | A copy-paste skeleton for a new connector.                                                                                                                                                                                   |

The catalog endpoint (`GET /api/connectors/catalog`, built in
`server/routes/connector-catalog.ts`) is the secret-free projection of the registry
the web app reads — it is the single bridge that lets a registered connector light
up the UI with no frontend list edits.

## What a connector declares

- **Identity + brand** — `id`, `displayName`, a `logo` id (resolved by the web
  `LOGO_REGISTRY`), an optional `summary` and `brandColor`.
- **Kinds** — each `KindManifest` carries a stable `kind` id, a `sourceType` (e.g.
  `"google:gmail"`) that drives the source chip + privacy default, a `contentMode`
  (`"metadata"` | `"document"`), a default poll interval, and the display +
  behaviour metadata the UI reads instead of hardcoding the kind: `noun`
  (singular/plural for the Sources grouping), `blurb`, `private` (privacy default —
  `true` keeps data off the wiki + off sync/export), and `capabilities`
  (`coverageWindow`, `labelFilters`, `subResources`, `writeable`).
- **Auth model** — an `AuthManifest`: `{ kind: "oauth2", scopes }` plus an
  `OAuthProvider` (build auth URL → exchange code → refresh → revoke; Google's is in
  `google/oauth.ts`), or `{ kind: "basic", fields }` declaring the credential form a
  service like IMAP collects (and no `oauth` member).
- **Emitted item format** — `fetchDelta` returns `NormalizedItem`s: the `externalId`
  (ledger key), `title`, a deep-link `path`, the **raw** provider payload (kept
  verbatim for reprocessing), the **normalized** human-readable text (what gets
  chunked / indexed / extracted), and the deterministic `extraction`.
- **Agent tools** (optional) — `agentTools(ctx)` returns the chat-agent tools the
  connector contributes when its account is connected; `promptHint` is the one-line
  description appended to the system prompt. The `ctx` provides the store, the
  embedder, the user's `enabledKinds`, and a **lazy** `getAccessToken()` (the token
  is minted only when a tool actually runs — no per-turn network cost).

## Lifecycle

```
configure  → save OAuth client id/secret (or basic credentials)  (routes: PUT …/credentials)
authenticate → consent + token exchange            (OAuthProvider.buildAuthUrl/exchangeCode)
initial sync → fetchDelta(ctx, kind, null)         (no cursor = full pull)
incremental  → fetchDelta(ctx, kind, savedCursor)  (delta since cursor)
retry/error  → fullResync clears a stale cursor;   a thrown error is recorded and retried
revoke       → OAuthProvider.revokeToken           (routes: DELETE …)
```

The orchestrator handles every step except `fetchDelta` and the OAuth calls — a
connector is **stateless** and never touches the DB, the schedule, or the
materialization seam.

## Authoring a new connector

The fast path:

```sh
pnpm connector:new <id>          # e.g. notion
```

This copies the template into `connectors/<id>/connector.ts`, registers it in
`registry.ts`, and stubs a `LOGO_REGISTRY` entry. Then:

1. Fill in the **manifest** (id, kinds, `sourceType`s, content modes, nouns,
   blurbs, capabilities) and the **auth model** (`OAuthProvider`, or `basic` fields).
2. Implement **`fetchDelta`**: call your provider, and for each changed item build a
   `NormalizedItem` — `rawContent` verbatim, `normalizedContent` as terse label-led
   text, and `extraction` from a deterministic mapper (see `map/helpers.ts`).
3. Optionally add **`agentTools`** + `promptHint` for the chat agent.
4. Replace the stubbed brand SVG in `LOGO_REGISTRY`
   (`packages/web/src/components/brand-logos.tsx`) under your `logo` id.

That's the whole surface. Registering the connector makes it appear in Settings,
the Health dashboard, the Sources tab, source chips, and the chat agent — and gives
its data the safe (off-wiki, off-sync) privacy defaults — with **no other edits**.
Privacy defaults come from each kind's `private` flag (no `CONNECTOR_SOURCE_TYPES`
list to maintain); the registry injects them on `register()`.
