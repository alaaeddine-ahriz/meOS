---
name: Connector request
about: Request a new connector or a change to an existing one
title: "connector: "
labels: connector
---

## Provider & data

Which provider and which kinds of data (e.g. contacts, calendar, messages)?

## Access model

- API / endpoints involved:
- Auth (OAuth scopes — read-only preferred):
- Is incremental/delta sync available (sync tokens, history IDs)?

## Privacy

What sensitivity should ingested items have (`normal` / `private` / `secret`)?
Should any of it be kept out of the git-synced wiki? See `docs/connectors.md` and
`docs/privacy.md`.

## Additional context

Rate limits, gotchas, prior art.
