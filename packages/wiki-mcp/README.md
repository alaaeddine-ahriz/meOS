# @meos/wiki-mcp

A thin **stdio MCP server** that lets your own agentic coding AI (Claude Code,
Claude Desktop, Codex, …) maintain your [meOS](https://github.com/) wiki — so the
LLM compute is billed to _your_ subscription instead of meOS's API budget.

It proxies to the wiki-maintenance endpoints on your running meOS server and
exposes them as MCP tools. meOS still owns the source-of-truth database: the
agent only rewrites page **prose**; facts, sources, links, and frontmatter are
never touched.

## Requirements

The meOS app (its HTTP server) must be running. By default the MCP server talks
to `http://127.0.0.1:4321`.

## Install

Register it with Claude Code:

```sh
claude mcp add meos -- npx -y @meos/wiki-mcp
```

(Claude Desktop / Codex: add an equivalent stdio server entry running
`npx -y @meos/wiki-mcp`.)

## Configuration

| Env var           | Default                 | Description                               |
| ----------------- | ----------------------- | ----------------------------------------- |
| `MEOS_SERVER_URL` | `http://127.0.0.1:4321` | Base URL of your running meOS HTTP server |

If the server isn't reachable, every tool returns a clear error telling you to
start the meOS app.

## Tools

| Tool           | Args                   | What it does                                                       |
| -------------- | ---------------------- | ------------------------------------------------------------------ |
| `wiki_queue`   | —                      | List pages needing work (stale / new sources / missing) + the mode |
| `wiki_context` | `{ slug }`             | Facts, sources, relationships, and linkable names to ground a page |
| `wiki_check`   | `{ slugs? }`           | Validate body + frontmatter without writing                        |
| `wiki_write`   | `{ slug, body }`       | Write a page body (for agents with no filesystem access)           |
| `wiki_commit`  | `{ slugs?, message? }` | Reconcile edited pages into the DB and git-commit                  |
| `wiki_mode`    | `{ mode? }`            | Read (no arg) or set (`in-app` \| `external` \| `hybrid`) the mode |

## Workflow

1. `wiki_queue` — find what needs work.
2. `wiki_context` — get the grounding facts for a page.
3. Edit the file on disk (or call `wiki_write`).
4. `wiki_check` — validate.
5. `wiki_commit` — reconcile + commit.

**Rules the agent must follow:** never edit the YAML frontmatter (meOS owns it);
link to other pages with `[[Exact Name]]` using a name from the context's
`linkableNames`; never transcribe private contact details.

Set the mode to `external` (`wiki_mode` with `{ "mode": "external" }`) so meOS
pauses its own paid auto-rewrite while you drive maintenance from here.
