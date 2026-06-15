# Agentic wiki editing — security boundary

MeOS regenerates each wiki page with an LLM agent (`WikiWriter`, in
`packages/core/src/wiki/writer.ts`). The agent is given tools to read, grep, and
edit Markdown. This document defines the security boundary that agent operates
inside and the controls that enforce it.

## Threat model

The agent runs untrusted model output with file-editing tools. The risks are:

1. **Filesystem escape** — the agent writes outside the wiki workspace (path
   traversal `../`, absolute paths, symlinks) to read or clobber host files, the
   SQLite database, credentials, or watched source files.
2. **Sensitive-data exfiltration** — private profile docs, connector metadata
   (tokens, account emails), or private/secret observations leak into a
   git-synced, portable wiki page.
3. **Runaway / abusive runs** — an unbounded run that hangs, emits huge output,
   touches many files, or produces an enormous page diff.
4. **Silent failure** — a malicious or failed tool call that leaves no trace.

## What the agent receives — a temp copy of wiki Markdown ONLY

The agent never touches the real data directory. `WikiWriter.regenerate` builds a
`bash-tool` sandbox with:

```ts
createBashTool({ uploadDirectory: { source: this.wikiDir, include: "**/*.md" } });
```

This is an **in-memory, copy-on-write overlay** populated with a copy of only the
`**/*.md` files under the wiki directory. The agent edits that copy; the writer
reads back exactly two fixed paths (`<type>/<slug>.md` and `SUMMARY.txt`) and
writes them to disk itself. The agent process has no DB handle, no connector
tokens, no profile documents, and no host-filesystem path.

Privacy at the data layer reinforces this: the prompt is built only from
`store.visibleObservations(entityId)` and `store.relationshipsFor(entityId)` —
private/secret claims (schema sensitivity rules) and non-`wiki_eligible` sources
(migration 18 source visibility) are filtered out _before_ anything reaches the
agent.

## Read / write / execute / never-touch matrix

| Resource                                  | Read | Write |     Execute      | Notes                                             |
| ----------------------------------------- | :--: | :---: | :--------------: | ------------------------------------------------- |
| Wiki Markdown copy (`**/*.md` in sandbox) |  ✅  |  ✅   | ✅ (cat/grep/ls) | Only ever a temp copy, not the live files         |
| `SUMMARY.txt` in sandbox                  |  ✅  |  ✅   |        —         | Directory summary the agent writes                |
| Host filesystem outside the workspace     |  ❌  |  ❌   |        ❌        | Blocked by the allowlist guard                    |
| Raw watched/source files                  |  ❌  |  ❌   |        ❌        | Never uploaded to the sandbox                     |
| SQLite database (`meos.db`)               |  ❌  |  ❌   |        ❌        | No handle in the sandbox                          |
| Connector metadata / OAuth tokens         |  ❌  |  ❌   |        ❌        | Live in the DB only                               |
| Private profile documents                 |  ❌  |  ❌   |        ❌        | Not uploaded; not in the prompt                   |
| Credentials / secrets / env               |  ❌  |  ❌   |        ❌        | Not present in the sandbox                        |
| Private / secret observations             |  ❌  |  ❌   |        ❌        | Filtered by `visibleObservations`                 |
| Network                                   |  ❌  |  ❌   |        ❌        | `just-bash` sandbox has no real network/FS egress |

The agent **never** receives, and must never be able to reach: raw watched files,
private profile docs, connector metadata, credentials, or the SQLite DB.

## Defence-in-depth controls (`packages/core/src/wiki/sandbox-guard.ts`)

On top of the sandbox isolation, the writer applies an explicit guard layer to
every agent-produced operation:

### 1. Filesystem allowlist

`guardTools` wraps the `writeFile`, `readFile`, and `bash` tools. Every
agent-supplied path is validated with `checkWorkspacePath` **before** it reaches
the sandbox. Rejected:

- absolute paths (`/etc/passwd`, `C:\…`, `\\UNC`),
- any `..` traversal segment,
- paths containing control characters / NUL.

A rejected path throws `WikiPathEscapeError`, which aborts the agent run. The
read-back paths the writer uses are also asserted with `assertInWorkspace`.

### 2. Execution limits (config with generous defaults)

`WikiSandboxLimits` (defaults in `DEFAULT_WIKI_SANDBOX_LIMITS`), enforced by
`RunLimitTracker`:

| Limit              | Default | Enforced                                                              |
| ------------------ | ------- | --------------------------------------------------------------------- |
| `runTimeoutMs`     | 120 000 | Wall-clock budget (race + per-tool check)                             |
| `maxOutputBytes`   | 256 KiB | Per write content / command size (also `bash-tool` `maxOutputLength`) |
| `maxFilesTouched`  | 32      | Distinct files mutated in a run                                       |
| `maxPageDiffBytes` | 128 KiB | Bytes the new page body may differ from the prior body                |

Defaults are deliberately generous so legitimate multi-section, multi-page edits
always succeed. On any breach the run aborts (`WikiLimitExceededError`), the
partial agent output is discarded, and the page falls back to the deterministic
`synthesizeBody()` — an oversized or abusive change is **never committed**.

### 3. Audit logging

Every guarded tool call, blocked path-escape, and limit violation is appended to
the governance `audit_log` table (migration 12) via `store.logAudit("wiki.tool",
…)`, recording the tool name, target path, success/failure, and the violation.
Failed or suspicious calls therefore surface in the Activity / debug views
alongside the per-run `wiki_run_events` transcript. No new table or migration was
required.

## Safe-failure invariant

If the agent escapes the workspace, exceeds a limit, hangs, or throws, the run is
marked failed and the page is rebuilt deterministically from the entity's own
visible knowledge. The wiki is never left empty and never receives an
out-of-bounds change.
