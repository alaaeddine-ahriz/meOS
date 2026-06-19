#!/usr/bin/env node
/**
 * @meos/wiki-mcp — a thin stdio MCP server that proxies to the running meOS
 * HTTP API so an external coding agent (Claude Code / Claude Desktop / Codex)
 * can maintain the meOS wiki on the user's own LLM budget.
 *
 * The meOS app/server must be running. Override its location with
 * MEOS_SERVER_URL (default http://127.0.0.1:4321).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  getContext,
  getMode,
  getQueue,
  postCheck,
  postCommit,
  postWrite,
  putMode,
  type WikiMaintenanceMode,
} from "./client.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Run a client call and shape it into an MCP tool result. */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

const WORKFLOW = [
  "meOS wiki maintenance — composition only. The SQLite DB is the source of",
  "truth; the markdown files are a compiled projection. You only rewrite the",
  "prose BODY of a page; you never invent facts.",
  "",
  "Loop: wiki_queue (find pages needing work) -> wiki_context (get the facts,",
  "sources, relationships, and linkable names that ground a page) -> edit the",
  "file on disk (or call wiki_write if you have no filesystem) -> wiki_check",
  "(validate) -> wiki_commit (reconcile DB + git commit).",
  "",
  "Rules: never edit the YAML frontmatter — meOS owns it. Link to other pages",
  "with [[Exact Name]] using a name from the context's linkableNames. Never",
  "transcribe private contact details (emails, phone numbers, addresses).",
].join("\n");

const server = new McpServer({ name: "meos-wiki", version: "0.0.0" });

server.registerTool(
  "wiki_queue",
  {
    description:
      "List the wiki pages that need work (stale, new sources, or missing). " +
      "Returns the current maintenance mode plus a queue of pages with their " +
      "slug, type, name, on-disk path, quality, and whether the file exists. " +
      "Start here.\n\n" +
      WORKFLOW,
    inputSchema: {},
  },
  () => run(() => getQueue()),
);

server.registerTool(
  "wiki_context",
  {
    description:
      "Fetch the grounding context for one page by its slug: the entity, the " +
      "current page body (if any), the extracted facts, typed relationships, " +
      "source excerpts, and the list of linkableNames you may reference with " +
      "[[Exact Name]]. Read this before composing a page — it is the only " +
      "material you may write from. Do not transcribe private contact details.",
    inputSchema: { slug: z.string().describe("The page slug, e.g. from wiki_queue") },
  },
  ({ slug }) => run(() => getContext(slug)),
);

server.registerTool(
  "wiki_check",
  {
    description:
      "Validate page(s) without writing: lints the on-disk body and asserts " +
      "the frontmatter entity_id/slug match meOS. Pass specific slugs, or omit " +
      "to check the whole queue. Returns per-page { ok, quality, frontmatterOk, " +
      "issues }. Run this after editing and before wiki_commit.",
    inputSchema: {
      slugs: z
        .array(z.string())
        .optional()
        .describe("Slugs to check; omit to check every queued page"),
    },
  },
  ({ slugs }) => run(() => postCheck(slugs)),
);

server.registerTool(
  "wiki_write",
  {
    description:
      "Write a page body to disk for agents with no filesystem access (e.g. " +
      "Claude Desktop). Provide the BODY only — never the YAML frontmatter, " +
      "which meOS owns and regenerates. meOS writes the file and returns a " +
      "check result. Prefer editing the file directly on disk when you can.",
    inputSchema: {
      slug: z.string().describe("The page slug to write"),
      body: z.string().describe("The page body (markdown prose, no frontmatter)"),
    },
  },
  ({ slug, body }) => run(() => postWrite(slug, body)),
);

server.registerTool(
  "wiki_commit",
  {
    description:
      "Reconcile edited page(s) into the DB and git-commit them. meOS strips " +
      "frontmatter, re-checks the body hash (unchanged pages are skipped), " +
      "regenerates its own frontmatter, embeds, marks the prose agent-authored, " +
      "and clears the stale flags. Pass slugs (or omit for the whole queue) and " +
      "an optional commit message. Pages with blocking issues are skipped and " +
      "reported. Run this last.",
    inputSchema: {
      slugs: z
        .array(z.string())
        .optional()
        .describe("Slugs to commit; omit to commit every queued page"),
      message: z.string().optional().describe("Optional git commit message"),
    },
  },
  ({ slugs, message }) => run(() => postCommit(slugs, message)),
);

server.registerTool(
  "wiki_mode",
  {
    description:
      "Read or set the wiki maintenance mode. Call with no argument to read the " +
      "current mode. Pass `mode` to set it: 'in-app' (meOS does the paid LLM " +
      "rewrites, default), 'external' (meOS pauses its paid auto-rewrite and " +
      "leaves pages for you), or 'hybrid' (both). Set 'external' before driving " +
      "maintenance from here so meOS doesn't reprocess your work.",
    inputSchema: {
      mode: z
        .enum(["in-app", "external", "hybrid"])
        .optional()
        .describe("Set the mode; omit to read the current mode"),
    },
  },
  ({ mode }) => run(() => (mode === undefined ? getMode() : putMode(mode as WikiMaintenanceMode))),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stdout is the MCP transport channel — log diagnostics to stderr only.
  console.error("[meos-wiki-mcp] fatal:", err);
  process.exit(1);
});
