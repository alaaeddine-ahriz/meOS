# 5. Git for syncing human-readable knowledge

Status: Accepted

## Context

Users want their compiled knowledge backed up and portable across machines,
without a proprietary sync service or cloud account. The valuable, portable
artifacts are the wiki, digests, and hand-written notes (Markdown); the SQLite DB
is derived state. A sync mechanism should be one users already trust and can
inspect, and must not export private knowledge.

## Decision

Version the human-readable knowledge as a plain Git repository rooted at `data/`.
Git sync (Settings → _Sync_) makes the first commit, optionally points an `origin`
remote at GitHub, and on demand (or nightly) commit-pull-pushes the Markdown. The
SQLite DB is `.gitignore`d. Auth flows through the user's existing git setup (SSH
agent, credential helper, or a token in the remote URL).

## Consequences

- Standard, inspectable history; users own the remote and the auth.
- Only `data/wiki/`, `data/digests/`, and `data/vault/` are tracked — and because
  the wiki only contains `normal` observations, private/secret claims are never
  pushed (see `0006`).
- The DB is rebuildable from watched files, so excluding it keeps the repo small
  and avoids syncing volatile derived state.
- Conflicts surface as ordinary git conflicts; sync inherits git's failure modes
  (diverged remotes, auth prompts) rather than hiding them.
