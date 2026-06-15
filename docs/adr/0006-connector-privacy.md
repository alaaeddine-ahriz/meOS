# 6. Connector privacy via observation sensitivity

Status: Accepted

## Context

Connectors ingest sensitive personal data — contact details (emails, phones,
birthdays) and Gmail metadata. This data should be usable for local search and
graph context, but it must not leak into the git-synced, potentially-shared wiki.
The boundary needs to be enforced in one place so it can't drift as new callers
build portable artifacts.

## Decision

Give every observation a `sensitivity` tier (`normal` / `private` / `secret`) and
enforce the boundary once, in `store.visibleObservations()`, which returns only
`normal` active observations. Connector-derived claims (contacts, email metadata)
are ingested as `private`. Every consumer that builds a portable artifact — the
wiki writer, exported briefs, the linter — reads through `visibleObservations()`
rather than re-filtering. OAuth itself is read-only and loopback + PKCE against
the user's own Google client, so raw access never leaves the device.

## Consequences

- Private knowledge is searchable locally but never reaches the wiki, and
  therefore never reaches git sync (see `0005`).
- A single chokepoint for the rule means new artifact builders inherit correct
  behavior by using the existing accessor.
- Tiering is per-observation, so the same entity can mix public and private facts
  without splitting the entity.
- Mis-tagging at ingest is the main risk: an item ingested as `normal` that should
  be `private` would be exposed, so connector mappers set the tier deliberately.
