# Connector framework / SDK

A **connector** is meOS's product primitive for an external integration (Google,
and, by this same interface, IMAP / Notion / a local folder / …). It is the
boundary between a provider's API and the ingestion pipeline: the connector pulls
a delta and **normalizes** each changed item; the orchestrator persists and
**materializes** it. Neither side reaches across that line, which is what lets a
new provider drop in **without touching the orchestrator** (`sync.ts`,
`connector-manager.ts`, or the routes).

## The pieces

| File                    | Role                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `framework.ts`          | The `Connector` interface: `ConnectorManifest`, `OAuthProvider`, `NormalizedItem`, `NormalizedDelta`.       |
| `registry.ts`           | `ConnectorRegistry` — look up a connector by provider id. `connectorRegistry` ships with Google registered. |
| `google/connector.ts`   | `GoogleConnector` — the reference implementation.                                                           |
| `sync.ts`               | The provider-agnostic orchestrator (`syncConnector`).                                                       |
| `template.connector.ts` | A copy-paste skeleton for a new connector.                                                                  |

## What a connector declares

- **Manifest** — `id`, `displayName`, and the `kinds` it syncs. Each
  `KindManifest` carries a stable `kind` id, a `sourceType` (e.g.
  `"google:contacts"`) that drives the **visibility defaults**
  (`knowledge/visibility.ts`, #11) and the source chip, a **content mode**
  (`"metadata"` for lightweight items like contacts/calendar, `"document"` for
  richer document-like items), and a default poll interval.
- **Auth model** — an `AuthManifest` (`oauth2` + scopes) plus an `OAuthProvider`
  (build auth URL → exchange code → refresh → revoke). Google's lives in
  `google/oauth.ts`.
- **Sync state / delta cursor** — an **opaque cursor string** per kind. The
  connector receives the saved cursor and returns the next one; the orchestrator
  persists it. A stale cursor is signalled with `fullResync: true`, and the
  orchestrator clears the cursor and re-pulls from scratch.
- **Emitted item format** — `fetchDelta` returns `NormalizedItem`s: the
  `externalId` (ledger key), a `title`, a deep-link `path`, the **raw** provider
  payload (kept verbatim for reprocessing), the **normalized** human-readable
  text (what gets chunked / indexed / extracted), and the deterministic
  `extraction` (entities / observations / relationships). This is exactly the
  shape #19's `pipeline.materialize()` consumes.

## Lifecycle

```
configure  → save OAuth client id/secret           (routes: PUT …/credentials)
authenticate → consent + token exchange            (OAuthProvider.buildAuthUrl/exchangeCode)
initial sync → fetchDelta(ctx, kind, null)         (no cursor = full pull)
incremental  → fetchDelta(ctx, kind, savedCursor)  (delta since cursor)
retry/error  → fullResync clears a stale cursor;   a thrown error is recorded in
               last_status and the next run retries
revoke       → OAuthProvider.revokeToken           (routes: DELETE …)
delete data  → markSourceGone (soft delete) keeps audit history; the ledger row
               survives for content-hash dedup if the item reappears
```

The orchestrator handles every step except `fetchDelta` and the OAuth calls — a
connector is **stateless** and never touches the DB, the schedule, or the
materialization seam.

## Authoring a new connector (4 steps)

1. Copy `template.connector.ts` into `connectors/<provider>/connector.ts`.
2. Fill in the manifest (id, kinds, `sourceType`s, content modes) and the
   `OAuthProvider`.
3. Implement `fetchDelta`: call your provider, and for each changed item build a
   `NormalizedItem` — `rawContent` verbatim, `normalizedContent` as terse
   label-led text, and `extraction` from a deterministic mapper (see
   `map/helpers.ts`). Return deletions and the next cursor.
4. Register it: `connectorRegistry.register(new MyConnector())`. The schedule,
   sync route, and visibility defaults pick it up automatically.

If `<provider>:<kind>` should be private by default (no git-sync / export), add
the `sourceType` to `CONNECTOR_SOURCE_TYPES` in `knowledge/visibility.ts`.
