# @meos/wiki-mcp

A thin **stdio MCP server** that lets your own agentic coding AI (Claude Code,
Claude Desktop, Codex, …) maintain your [meOS](../../README.md) wiki — so the
LLM compute is billed to _your_ subscription instead of meOS's API budget.

It proxies to the wiki-maintenance endpoints on your running meOS server and
exposes them as MCP tools. meOS still owns the source-of-truth database: the
agent only rewrites page **prose**; facts, sources, links, and frontmatter are
never touched.

## Requirements

The meOS app (its HTTP server) must be running. By default the MCP server talks
to `http://127.0.0.1:4321`.

## Install

> **Not published to npm yet.** Run it from this repo (below). A registry path
> (`npx -y @meos/wiki-mcp`) will work only once the package is published.

The MCP server is spawned by your coding agent, separately from the meOS app
(`pnpm dev` runs the app on `:4321` but not this server). Register it from
source one of two ways:

**Run from source — no build step.** `dev` runs straight from `src/` with tsx.
Add it from the repo root so the pnpm workspace filter resolves:

```sh
claude mcp add meos -- pnpm --filter @meos/wiki-mcp dev
```

**Build once, register the built entry by absolute path.** This is
cwd-independent (handy for Claude Desktop / Codex, which don't run from the
repo root):

```sh
pnpm --filter @meos/wiki-mcp build      # or `pnpm build` (builds every package)
claude mcp add meos -- node /absolute/path/to/meOS/packages/wiki-mcp/dist/index.js
```

Claude Desktop / Codex: add an equivalent stdio server entry running the same
command. Either way, start the meOS app first (`pnpm dev`) — every tool errors
clearly until the server on `:4321` is reachable. Point at a server on another
host or port with `MEOS_SERVER_URL` (see [Configuration](#configuration)).

## Configuration

| Env var           | Default                 | Description                               |
| ----------------- | ----------------------- | ----------------------------------------- |
| `MEOS_SERVER_URL` | `http://127.0.0.1:4321` | Base URL of your running meOS HTTP server |

If the server isn't reachable, every tool returns a clear error telling you to
start the meOS app.

## Tools

| Tool                   | Args                       | What it does                                                                                              |
| ---------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `wiki_search`          | `{ query }`                | Free-text search the knowledge base to answer questions; returns matching entities (with slugs) + sources |
| `wiki_queue`           | —                          | List pages needing work (stale / new sources / missing) + the mode                                        |
| `wiki_context`         | `{ slug }`                 | Facts, sources, relationships, and linkable names to ground a page                                        |
| `wiki_check`           | `{ slugs? }`               | Validate body + frontmatter without writing                                                               |
| `wiki_write`           | `{ slug, body }`           | Write a page body (for agents with no filesystem access)                                                  |
| `wiki_commit`          | `{ slugs?, message? }`     | Reconcile edited pages into the DB and git-commit                                                         |
| `wiki_mode`            | `{ mode? }`                | Read (no arg) or set (`in-app` \| `external` \| `hybrid`) the mode                                        |
| `wiki_sources`         | —                          | List indexed sources with no facts yet — the extraction queue (`external` mode only)                      |
| `wiki_extract_context` | `{ sourceId }`             | A source's normalized text + the fact schema to emit (every quote must be verbatim)                       |
| `wiki_submit_facts`    | `{ sourceId, extraction }` | Submit extracted facts; meOS validates verbatim quotes, merges them, and flags touched pages stale        |

Beyond these curated tools, the server **auto-generates** read/act tools from the
running meOS server's capability surface at startup (the curated names above are
reserved so a generated tool never shadows them).

## Workflow

**Rewrite pages** (the main loop):

1. `wiki_queue` — find what needs work.
2. `wiki_context` — get the grounding facts for a page.
3. Edit the file on disk (or call `wiki_write`).
4. `wiki_check` — validate.
5. `wiki_commit` — reconcile + commit.

**Extract facts from raw sources** (`external` mode, when meOS indexes a source
but leaves the LLM extraction to you):

1. `wiki_sources` — list sources awaiting extraction.
2. `wiki_extract_context` — read a source's text plus the fact schema to emit.
3. `wiki_submit_facts` — submit facts (quotes copied verbatim); the touched
   entities' pages then surface in `wiki_queue`.

**Rules the agent must follow:** never edit the YAML frontmatter (meOS owns it);
link to other pages with `[[Exact Name]]` using a name from the context's
`linkableNames`; never transcribe private contact details.

Set the mode to `external` (`wiki_mode` with `{ "mode": "external" }`) so meOS
pauses its own paid auto-rewrite while you drive maintenance from here.

## A second entry: `@meos/wiki-mcp/connectors`

This package also ships a `./connectors` stdio server used **internally** by
meOS's own agent mode (the local Claude Code CLI launched from chat). It exposes
your live connected services (Google calendar / tasks / email / contacts, and
any other connector) as MCP tools, proxying every call back to the meOS server
so the CLI never sees a credential or runs an OAuth flow. You don't register this
one yourself — meOS launches it — and it honours the same `MEOS_SERVER_URL`.
