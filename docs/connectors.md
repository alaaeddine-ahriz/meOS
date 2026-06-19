# Connectors

Connectors turn external accounts into knowledge through the same merge path as
any ingested document. A connector is a self-contained **plugin**: it declares its
identity + branding, the data **kinds** it syncs, its **auth model**, and the
**agent tools** it gives the chat assistant — all in one manifest. Everything else
(the catalog the UI renders from, the privacy defaults, the sync schedule, the
routes) is derived from that manifest, so a new connector **appears in every view
automatically**. Code lives in
[`packages/core/src/connectors/`](../packages/core/src/connectors/); Google is the
reference implementation.

## Adding a connector

```sh
pnpm connector:new notion        # scaffolds connectors/notion/, registers it, stubs a logo
```

Then fill in three things in `connectors/notion/connector.ts`:

1. **The manifest** — id, display name, `logo` id, and each kind's `sourceType`,
   `noun`, `blurb`, privacy, and `capabilities`. This drives the UI, the catalog,
   the privacy defaults, and the source chips.
2. **`fetchDelta`** — pull a delta and normalize each changed item.
3. **`agentTools`** (optional) — the tools the chat agent gains when the account is
   connected, plus a one-line `promptHint`.

Drop the brand SVG into `LOGO_REGISTRY` in
[`brand-logos.tsx`](../packages/web/src/components/brand-logos.tsx) under the `logo`
id you chose — the one irreducible frontend artifact (an SVG is a React component).
That's it: the connector now shows up in Settings, the Health dashboard, the
Sources tab, source chips, and the chat agent, with the right privacy defaults.

See [`connectors/README.md`](../packages/core/src/connectors/README.md) for the full
authoring guide and the framework contract.

## Auth

Two auth models are supported, declared in the manifest's `auth`:

- **OAuth2** — a hosted consent flow + token refresh. Google uses loopback + PKCE
  (S256) against your _own_ Google Cloud "Desktop app" client, so tokens never pass
  through anyone else ([`google/oauth.ts`](../packages/core/src/connectors/google/oauth.ts)).
  There is no `googleapis` dependency — raw `fetch` to the token endpoints.
- **Basic** — the connector declares the credential `fields` it needs (host,
  username, password, …) and the settings UI renders the form from them. For a
  service like IMAP that has no consent screen.

Credentials + tokens are stored in the `connector_accounts` table (in the DB, never
near source files), and OAuth tokens are refreshed automatically.

## Google: Contacts, Calendar, Gmail, Tasks

The reference connector. Contacts/Calendar/Gmail are read-only; Tasks is
read/write (the agent can create tasks).

- **Contacts** (People API) → `person` entities (emails, phones, org, title, birthday).
- **Calendar** events → entities that link the people you met with.
- **Gmail** metadata → who you correspond with (subject, participants, snippet —
  never the full body unless you opt into rich content). The Gmail connector also
  contributes the `fetch_email_threads` **agent tool**, so the assistant can read
  the contents of correspondence on demand.
- **Tasks** → your to-dos, with a write path to create new ones.

## Background sync

Each kind syncs on its own interval, tracked per account in `connector_sync_state`.
Sync is **incremental**: provider sync tokens / history IDs are persisted as a
cursor and only the delta is pulled. When a cursor expires (e.g. Google 410 GONE)
the run does a full resync and stores a fresh cursor. A content-hash ledger
(`connector_items`) skips items whose bytes are unchanged since the last sync.

## Privacy

Connector data is `private` by default — searchable + answerable on this machine,
but kept out of the git-synced wiki and off exports. This default comes straight
from each kind's manifest (`private`, defaulting to true); a connector opts a kind
out with `private: false`. See [`privacy.md`](privacy.md).
