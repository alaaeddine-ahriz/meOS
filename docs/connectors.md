# Connectors

Connectors turn external accounts into knowledge through the same merge path as
any ingested document. Google is the first (and currently only) provider, behind
a provider-agnostic interface so others can slot in later. Code lives in
[`packages/core/src/connectors/`](../packages/core/src/connectors/); the server's
sync manager schedules runs.

## Google: Contacts, Calendar, Gmail

Three kinds, all **read-only**:

- **Contacts** (People API) → `person` entities with details (emails, phones,
  org, title, birthday).
- **Calendar** events → entities that link the people you met with.
- **Gmail** metadata → who you correspond with (subject, participants, snippet —
  never the full body).

## OAuth

Auth is loopback + PKCE (S256) against your _own_ Google Cloud "Desktop app"
client, so tokens never pass through anyone else
([`google/oauth.ts`](../packages/core/src/connectors/google/oauth.ts)). Scopes
are read-only: `contacts.readonly`, `calendar.readonly`, `gmail.readonly`, plus
`userinfo.profile` / `userinfo.email` / `openid` to read the account owner's own
identity (to anchor "knows" edges to you). There is no `googleapis` dependency —
raw `fetch` to Google's token endpoints.

Tokens are stored in the `connector_accounts` table (in the DB, never near source
files), and refreshed automatically.

## Background sync

Each kind syncs on its own interval (default 15 min), tracked per account in
`connector_sync_state`. Sync is **incremental**: Google sync tokens / history IDs
are persisted as a cursor and only the delta is pulled. When a cursor expires
(Google 410 GONE) the run does a full resync and stores a fresh cursor.

A content-hash ledger (`connector_items`) skips items whose bytes are unchanged
since the last sync, so re-syncing doesn't re-merge unchanged contacts or events.

## Privacy

Contact details and email metadata are ingested as `private` observations:
searchable on this machine, but kept out of the git-synced wiki. See
[`privacy.md`](privacy.md).
