import { createRequire } from "node:module";
import type { McpServerSpec } from "@meos/core";

/**
 * Builds the meOS MCP injection — the wiki/knowledge + live-connector tools meOS
 * exposes to a coding agent, each pointed at this server's own HTTP API.
 *
 * Lives in its own module (rather than coding-agent-command.ts) so BOTH the chat
 * agent-mode path AND the intelligence-routing layer (context.ts, for the wiki
 * maintainer) can build it without importing coding-agent-command — which would
 * close the documented `command → context → command` module cycle. It depends only
 * on the server PORT, not the full AppContext, which keeps it cycle-free.
 */

const require = createRequire(import.meta.url);

/**
 * Locate a built `@meos/wiki-mcp` entry (the package, or its `./connectors`
 * subpath) to spawn as a stdio MCP server. Each proxies to our own HTTP API, so
 * an agent run dogfoods the exact MCP-over-HTTP path. Returns the command + args
 * (run with our own Node), or null if that entry isn't built/installed — the
 * agent then simply runs without that toolset rather than failing.
 */
function resolveMcpEntry(spec: string): { command: string; args: string[] } | null {
  try {
    return { command: process.execPath, args: [require.resolve(spec)] };
  } catch {
    return null;
  }
}

/**
 * Build the meOS MCP injection for an agent run: the `--mcp-config` JSON that
 * registers our wiki/knowledge tools AND the user's live connector tools (each
 * pointed at this server's own port), plus a system-prompt addendum teaching the
 * agent to use them — and, for connectors, to rely on meOS's existing auth rather
 * than authenticating anything itself. Returns null only when NO MCP entry can be
 * located, so the run proceeds tool-less.
 */
export function buildMeosMcp(
  serverPort: number,
  op: string,
): { servers: Record<string, McpServerSpec>; systemPrompt: string } | null {
  const wiki = resolveMcpEntry("@meos/wiki-mcp");
  const connectors = resolveMcpEntry("@meos/wiki-mcp/connectors");
  if (!wiki && !connectors) {
    console.warn(
      "[coding-agent] @meos/wiki-mcp not found (build it with `pnpm --filter @meos/wiki-mcp build`); " +
        "running the agent without meOS knowledge or connector tools.",
    );
    return null;
  }
  // MEOS_AGENT_OP lets the connectors MCP child's `ask_user` tool address THIS
  // run, so a mid-run question reaches the right chat stream (see ask-registry).
  const env = {
    MEOS_SERVER_URL: `http://127.0.0.1:${serverPort}`,
    MEOS_AGENT_OP: op,
  };
  // Canonical, agent-neutral server map. Each agent definition translates this
  // into its own MCP wiring (Claude's --mcp-config JSON, Codex's config.toml,
  // Cursor/Gemini project config files, Copilot's --additional-mcp-config).
  const servers: Record<string, McpServerSpec> = {};
  if (wiki) servers.meos = { command: wiki.command, args: wiki.args, env };
  if (connectors) {
    servers["meos-connectors"] = { command: connectors.command, args: connectors.args, env };
  }
  return { servers, systemPrompt: MEOS_SYSTEM_PROMPT };
}

/** Tells the agent the meOS tools exist and when to reach for them. */
const MEOS_SYSTEM_PROMPT = [
  "You are connected to meOS — the user's personal knowledge base (their notes,",
  "people, projects, decisions, and sources) — through MCP tools on the `meos`",
  "server (names prefixed `mcp__meos__`). Your working directory is an empty",
  "scratch space; the user's knowledge lives behind these tools, not on disk.",
  "",
  "To ANSWER QUESTIONS about the user, prefer these over guessing or grepping files:",
  "- wiki_search — free-text search; start here. Returns matching entities (with",
  "  slugs) and the sources behind them.",
  "- wiki_context — a page's facts, relationships, source excerpts, and current",
  "  body, by slug.",
  "- wiki_sources / wiki_extract_context — list sources and read a source's full text.",
  "",
  "To MAINTAIN the wiki, follow the tools' own workflow: set wiki_mode to",
  "'external' first, then wiki_queue → wiki_context → wiki_write → wiki_check →",
  "wiki_commit. Only ever rewrite a page's prose body; never invent facts or edit",
  "frontmatter. Fall back to your other tools only for genuine coding/file work.",
  "",
  "You ALSO have live tools for the user's connected services on the",
  "`meos-connectors` server (names prefixed `mcp__meos-connectors__`) — e.g.",
  "Google calendar, tasks, email, and contacts when those are connected. Use them",
  "for up-to-the-minute data the wiki won't have (future events, email bodies,",
  "current tasks) or to act on the user's behalf (e.g. create a task).",
  "",
  "These tools run against the accounts the user ALREADY connected in meOS, using",
  "the existing authorization. NEVER ask the user to authenticate again, and never",
  "set up your own Google/credentials, API keys, gcloud, or a separate MCP for a",
  "service meOS already covers — just call the meos-connectors tool. If a tool",
  "reports the account needs reconnecting, tell the user to reconnect it in meOS",
  "settings; do not attempt your own auth flow.",
  "",
  "You run headless — there is no terminal to prompt. When the request is genuinely",
  "ambiguous or a decision is the user's to make (which target? overwrite or merge?",
  "which of these matches?), DON'T guess or stall: call the `ask_user` tool on the",
  "meos-connectors server with 1–4 multiple-choice questions, then continue with",
  "their answer. Reserve it for real forks — prefer your own tools and judgment for",
  "anything you can resolve yourself.",
].join("\n");
