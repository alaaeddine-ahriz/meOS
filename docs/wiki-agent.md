# Maintaining the wiki with your own coding agent

meOS keeps a wiki: one Markdown page per entity (people, projects, places, …),
each a summary of everything the system knows. Normally meOS rewrites those
pages itself with its own LLM budget. This page is about the **other** option —
handing that upkeep to your own agentic coding AI (Claude Code, Codex, Claude
Desktop) so the writing is billed to _your_ subscription instead of meOS's API.

## Overview

This is an **addition**, not a replacement. The in-app path keeps working; the
external-agent path runs alongside it. Both share **one status ledger**, so
neither reprocesses what the other already did, and you can switch between them
whenever you like.

The agent only ever rewrites **prose**. The facts, sources, and links a page is
built from live in the meOS database and are re-joined on read — so handing off
the writing never costs you any of the underlying knowledge.

## How it works

The SQLite database is the source of truth; the Markdown files are a compiled
projection of it. Your agent reads a page's context, rewrites the prose, and
commits — and that's all it touches:

- **Facts** (the underlying observations) are owned by meOS. The agent reads
  them; it never edits them.
- **Sources** (the indexed material behind each fact) are likewise read-only
  context.
- **Links and relationships** are re-derived from the database on every read.

So "keep every fact and link" holds **by construction**. The worst a bad rewrite
can do is produce weak prose — which `wiki_check` catches and you can redo.

## Setup

1. **Flip maintenance mode to `external`.** This pauses the paid in-app
   auto-rewrite and leaves the queue for your agent. Use the MCP `wiki_mode`
   tool (call it with `{ mode: "external" }`) or change it in meOS settings. The
   default is `in-app`, so nothing changes until you opt in.

2. **Add the meOS MCP server** to your coding agent. With Claude Code:

   ```sh
   claude mcp add meos -- npx -y @meos/wiki-mcp
   ```

   The meOS app **must be running** — the MCP server is a thin proxy over the
   local meOS HTTP API. By default it talks to `http://127.0.0.1:4321`; set
   `MEOS_SERVER_URL` if your server listens elsewhere.

Once both are done, point your agent at the wiki and ask it to work the queue.
The wiki directory also ships an `AGENTS.md` / `CLAUDE.md` that teaches any agent
the rules below automatically.

## The loop

Maintenance is a five-step loop. The MCP tools map one-to-one onto it:

1. **`wiki_queue`** — list the pages with new material waiting to be rewritten.
2. **`wiki_context`** `{ slug }` — pull the entity, current body, facts (with
   confidence scores), relationships, linkable names, and source excerpts.
3. **Edit the page** at `<type>/<slug>.md`, or call **`wiki_write`**
   `{ slug, body }` if your agent has no filesystem access.
4. **`wiki_check`** `{ slugs? }` — lint the prose and confirm the frontmatter is
   intact.
5. **`wiki_commit`** `{ slugs?, message? }` — persist, re-embed, and record the
   git commit.

The agent writes **body prose only** — never the YAML frontmatter (meOS owns
`entity_id`, `slug`, and the counts), links other entities with
`[[Exact Entity Name]]`, uses only the facts in the context, hedges
low-confidence ones, and never transcribes private contact details (the wiki is
git-synced and shareable).

## Extracting facts too (optional)

Everything above offloads **page composition** (facts → prose). You can also
offload **extraction** (raw source → facts), so essentially all of meOS's
recurring LLM cost moves to your subscription. meOS still does the
correctness-critical, deterministic work — entity-resolution, char-span
provenance, secret redaction, and dedup.

In `external` mode, when a new source arrives meOS parses and indexes it (so it
stays searchable) but **skips the paid LLM extraction**, leaving it for you:

1. **`wiki_sources`** — sources that are indexed but have no facts yet.
2. **`wiki_extract_context`** `{ sourceId }` — the source's text plus the exact
   fact schema to emit.
3. Produce `entities`, `relationships`, and `observations`. Every observation's
   **`sourceQuote` must be copied verbatim** from the text.
4. **`wiki_submit_facts`** `{ sourceId, extraction }` — meOS validates the quotes
   (a non-verbatim quote is rejected) and merges the rest through the **same
   pipeline as its own extractor**, then flags the touched pages stale. They show
   up in `wiki_queue`, and you continue with the prose loop.

Because the verbatim-quote gate and the shared merge run server-side, a
hallucinated or mis-quoted fact is rejected before it can enter the graph — so
"keep the underlying facts and sources" still holds.

## Shared status and idempotency

The work queue is shared. `wiki_stale` is the same ledger the in-app path uses,
so whichever path runs, the other won't redo the same page:

- Each committed page records a `body_hash`. If a page's body is unchanged since
  the last commit, it's **skipped** — `wiki_commit` reports it as `unchanged`
  rather than rewriting it. An already-reconciled page with no new facts costs
  nothing.
- Agent-authored pages are marked `authored_by=agent`, so the in-app refresh
  paths **don't clobber** them.
- You can **flip back to in-app anytime** via `wiki_mode`. The queue carries
  over; meOS just resumes writing the pages itself.

## What's preserved

By construction, switching to the external agent loses **nothing**:

- **Links** are re-derived from the database on read.
- **Sources** stay attached to their facts in the database.
- **Underlying facts** (observations) are never touched by the prose layer.

The agent's edits live entirely in the prose. Everything the rest of meOS relies
on — search, embeddings, relationships, source provenance — is unaffected.

## FAQ

**Does this cost API money?** No. The whole point is that _your_ coding agent's
subscription does the writing. meOS spends nothing on the rewrite when mode is
`external`.

**What about extraction — pulling facts out of new sources?** You can offload
that too (see "Extracting facts too" above). In `external` mode meOS indexes a
source but leaves the LLM extraction to your agent via `wiki_sources` →
`wiki_extract_context` → `wiki_submit_facts`. meOS still runs entity-resolution,
provenance, and dedup deterministically, and rejects any fact whose source quote
isn't verbatim. In `in-app` mode, extraction stays in-app as before.
