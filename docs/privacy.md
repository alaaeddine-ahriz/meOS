# Privacy

MeOS is local-first: your data lives in `data/` in portable formats and nothing
requires MeOS to read. This page covers the _sensitivity_ boundary that keeps
private knowledge out of shareable artifacts.

## Observation sensitivity

Every observation carries a `sensitivity` tier
([`db/database.ts`](../packages/core/src/db/database.ts), migration 8):

| Tier      | Meaning                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `normal`  | Default. Safe to compile into portable artifacts (the wiki, exported briefs).                                               |
| `private` | Searchable on this machine, but kept out of the git-synced wiki. Used for connector data — contact details, email metadata. |
| `secret`  | Most restrictive; excluded from portable artifacts.                                                                         |

## The `visibleObservations` filter

The privacy boundary lives in one place:
[`store.visibleObservations()`](../packages/core/src/knowledge/store.ts), which
returns active observations filtered to `sensitivity === "normal"`. Every caller
that builds a portable artifact — the wiki writer, exported briefs, the wiki
linter — reads through it instead of re-implementing a filter, so the rule can't
drift caller to caller.

## What stays on-device

- **Embeddings** are computed locally (see [`llm-providers.md`](llm-providers.md)).
- **The SQLite DB** (`data/meos.db`) is `.gitignore`d — it is derived state and
  never git-synced.
- **Connector data** (contacts, email metadata) is ingested as `private` by
  default, so it's searchable locally but never written to the git-synced wiki.
  The default comes from each connector kind's `private` flag in its manifest:
  registering a connector injects its private source types into
  `knowledge/visibility.ts`, so defaults track the registry instead of a
  hardcoded list. See [`connectors.md`](connectors.md).
- **Profile documents** stay private to this machine by default.

## Git sync

Git sync (Settings → _Sync_) versions only the human-readable knowledge —
`data/wiki/`, `data/digests/`, `data/vault/`. Because only `normal` observations
reach the wiki, enabling sync (and pushing to a remote) never exports your
`private`/`secret` claims. Auth flows through your normal git setup (SSH agent,
credential helper, or a token in the remote URL).
