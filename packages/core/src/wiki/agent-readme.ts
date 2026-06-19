import fs from "node:fs";
import path from "node:path";

/**
 * Teaching content dropped into the wiki directory on boot so that any coding
 * agent (Claude Code, Codex, Claude Desktop, …) the user points at the wiki can
 * maintain it correctly. The content mirrors the in-app maintainer's rules so
 * both paths produce the same kind of page.
 */
export const WIKI_AGENTS_MD = `# Maintaining this wiki

You are looking at a **meOS wiki** — a compiled projection of a personal
knowledge database. Each Markdown file describes one entity (a person, project,
place, …) and summarises everything the system knows about it.

Your job, if you've been asked to help, is to keep the **prose** on these pages
accurate and well-written. That's the *only* thing you touch. The facts,
sources, and links that the prose is built from live in the meOS database and
are re-joined into each page on read — you never edit those, and nothing you do
can lose them.

## What this wiki is (and isn't)

- The database is the **source of truth**. These files are a *projection* of it.
- You rewrite **prose only**. Facts (the underlying observations), source
  excerpts, and typed relationships are owned by meOS and survive untouched.
- Because of that, "keep every fact and link" holds **by construction** — you
  literally cannot drop them by editing prose.

## The loop

Maintenance is a small loop. Use the meOS MCP tools if you have them; otherwise
edit the files directly (the page lives at \`<type>/<slug>.md\`, e.g.
\`person/ada-lovelace.md\`).

1. **\`wiki_queue\`** — list the pages that have new material and are waiting to
   be rewritten. This is the shared work queue; pick a page from it.
2. **\`wiki_context\`** \`{ slug }\` — pull everything you need to write the page:
   the entity, the current body, the facts (each with a confidence score), the
   relationships, the linkable entity names, and excerpts from the underlying
   sources. **Write only from this.**
3. **Edit the page.** Either edit \`<type>/<slug>.md\` on disk, or call
   **\`wiki_write\`** \`{ slug, body }\` (for agents without filesystem access).
   Write the **body prose only** — see the rules below.
4. **\`wiki_check\`** \`{ slugs? }\` — lint your work. It verifies the prose and
   confirms the frontmatter is intact. Fix anything it flags.
5. **\`wiki_commit\`** \`{ slugs?, message? }\` — persist the page. meOS re-embeds
   it, clears it from the queue, and records the git commit. Pages with blocking
   issues are skipped and reported, not committed.

## The hard rules

These are non-negotiable. They match exactly what the in-app maintainer follows.

- **NEVER edit the YAML frontmatter.** The block at the top of each file
  (\`entity_id\`, \`slug\`, counts, …) is **owned by meOS**. Write body prose only —
  no top-level \`# Title\`, no frontmatter. If you call \`wiki_write\`, send only
  the body; meOS re-attaches the frontmatter.
- **Only use facts from \`wiki_context\`.** Never add outside knowledge,
  speculation, or anything not present in the provided observations,
  relationships, and source excerpts. If it isn't in the context, it doesn't go
  on the page.
- **Hedge low-confidence facts.** Each observation comes with a confidence
  score. State high-confidence facts plainly; hedge the rest explicitly — "a
  single note suggests…", "as of <date>…".
- **Link other entities with \`[[Exact Entity Name]]\`.** Use the exact names from
  the \`linkableNames\` list in the context — match them character-for-character.
  Link each entity at most a few times, and never link a page to itself.
- **NEVER transcribe private contact details.** The source excerpts may contain
  email addresses, phone numbers, or postal addresses. Use them only to
  understand context, relationships, and events — **never copy them into the
  page.** This wiki is git-synced and meant to be shareable.
- **Prefer editing over rewriting.** Keep the prose that's still accurate, weave
  in the new facts, and only rewrite the parts the new observations actually
  change. Write a page from scratch only if it doesn't exist yet.

## A good page

- A short opening paragraph, then \`## \` sections only if there's enough material
  to justify them.
- Clear, factual prose — the voice of someone who has read every relevant source
  and is summarising it for you.
- Relationships woven into the prose as \`[[backlinks]]\`, not dumped in a list.

## Shared status — don't fight the in-app path

meOS may also rewrite these pages itself (the "in-app" path), and the two share
one status ledger:

- A page that's already reconciled — its body unchanged since the last commit —
  is **skipped**. \`wiki_commit\` reports it as \`unchanged\` rather than
  rewriting it. Don't churn pages that have no new facts.
- Pages you author are marked \`authored_by=agent\` so the in-app refresh paths
  won't clobber your work.
- The user can switch the maintenance mode between in-app and external at any
  time. When it's \`external\`, the paid in-app rewrite pauses and leaves the
  queue for you; when it's \`in-app\`, meOS handles it. Either way, work the queue
  \`wiki_queue\` hands you and you'll never collide.

That's the whole job: pull context, rewrite prose, check, commit. The database
keeps the facts; you keep the writing good.
`;

/**
 * Write the teaching docs (\`AGENTS.md\` + an identical \`CLAUDE.md\`) into the wiki
 * directory, creating it if needed. Idempotent — overwrites each time so updates
 * to {@link WIKI_AGENTS_MD} propagate. Best-effort: any failure is swallowed so a
 * boot-time caller never throws on it.
 */
export function writeWikiAgentDocs(wikiDir: string): void {
  try {
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, "AGENTS.md"), WIKI_AGENTS_MD);
    fs.writeFileSync(path.join(wikiDir, "CLAUDE.md"), WIKI_AGENTS_MD);
  } catch {
    // Best-effort: the teaching docs are a convenience, never a boot dependency.
  }
}
