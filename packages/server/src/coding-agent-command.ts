import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runClaudeCodeAgent } from "@meos/core";
import type { AppContext } from "./context.js";

const require = createRequire(import.meta.url);

/**
 * Agent mode: route a chat turn to the user's local coding agent (Claude Code)
 * instead of the knowledge-base assistant. The run's reasoning, tool calls, and
 * answer are forwarded over the SAME SSE frame vocabulary the chat already
 * speaks (`reasoning` / `tool-call` / `tool-result` / `delta`), so the existing
 * chat UI renders it with no new components. The conversation is persisted like
 * any other (user turn + final answer), so agent turns survive a reload; the
 * CLI session id is remembered per conversation so follow-up turns `--resume` it.
 */

type Send = (event: Record<string, unknown>) => void;

interface AgentSettings {
  /** Working directory the agent operates in. Defaults to a sandbox under the data dir. */
  cwd?: string;
  /** Model id. */
  model?: string;
}

const SETTINGS_KEY = "coding-agent";
const sessionKey = (conversationId: number) => `coding-agent:session:${conversationId}`;

/** Override the per-turn model with one supplied by the request, else the stored default. */
function resolveRun(ctx: AppContext, conversationId: number, modelOverride?: string) {
  const settings = ctx.store.getSetting<AgentSettings>(SETTINGS_KEY) ?? {};
  // Default to a dedicated workspace under the data dir — a contained, writable
  // place for the agent (which runs with permissions bypassed) to do its work.
  const cwd = settings.cwd?.trim() || path.join(ctx.config.dataDir, "coding-agent");
  fs.mkdirSync(cwd, { recursive: true });
  const model = modelOverride?.trim() || settings.model?.trim() || undefined;
  const resumeSessionId = ctx.store.getSetting<string>(sessionKey(conversationId)) ?? undefined;
  return { cwd, model, resumeSessionId };
}

/**
 * Locate the built `@meos/wiki-mcp` entry to spawn as a stdio MCP server. It
 * proxies to our own HTTP API, so an agent run dogfoods the exact external-agent
 * path. Returns the command + args (run with our own Node), or null if the
 * package isn't built/installed — in which case the agent simply runs without
 * meOS tools rather than failing.
 */
function resolveWikiMcp(): { command: string; args: string[] } | null {
  try {
    return { command: process.execPath, args: [require.resolve("@meos/wiki-mcp")] };
  } catch {
    return null;
  }
}

/**
 * Build the meOS MCP injection for an agent run: the `--mcp-config` JSON that
 * registers our wiki/knowledge tools (pointed at this server's own port) plus a
 * system-prompt addendum that teaches the agent to use them. Returns null when
 * the MCP server can't be located, so the run proceeds tool-less.
 */
function buildMeosMcp(ctx: AppContext): { mcpConfig: string; appendSystemPrompt: string } | null {
  const entry = resolveWikiMcp();
  if (!entry) {
    console.warn(
      "[coding-agent] @meos/wiki-mcp not found (build it with `pnpm --filter @meos/wiki-mcp build`); " +
        "running the agent without meOS knowledge tools.",
    );
    return null;
  }
  const mcpConfig = JSON.stringify({
    mcpServers: {
      meos: {
        command: entry.command,
        args: entry.args,
        env: { MEOS_SERVER_URL: `http://127.0.0.1:${ctx.config.server.port}` },
      },
    },
  });
  return { mcpConfig, appendSystemPrompt: MEOS_SYSTEM_PROMPT };
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
].join("\n");

export async function runCodingAgent(
  ctx: AppContext,
  conversationId: number,
  message: string,
  send: Send,
  signal?: AbortSignal,
  model?: string,
): Promise<void> {
  const prompt = message.trim();
  const firstTurn = ctx.store.listMessages(conversationId).length === 0;
  ctx.store.addMessage(conversationId, "user", prompt);
  if (firstTurn) ctx.store.setConversationTitle(conversationId, prompt.slice(0, 80));

  const { cwd, model: runModel, resumeSessionId } = resolveRun(ctx, conversationId, model);
  // Give the agent meOS's own wiki/knowledge tools, pointed at this server.
  const meos = buildMeosMcp(ctx);

  let reply = "";
  let resultText = "";
  let failure: string | null = null;
  let sawResult = false;
  // The wiki pages + source documents the agent consulted through its meOS tools
  // (wiki_search / wiki_context) — surfaced under the answer like the chat's own
  // citations, so the user can see (and open) what grounded the reply.
  const sourcesById = new Map<number, AgentSource>();
  const pagesBySlug = new Map<string, AgentPage>();

  for await (const event of runClaudeCodeAgent({
    prompt,
    cwd,
    model: runModel,
    resumeSessionId,
    signal,
    mcpConfig: meos?.mcpConfig,
    appendSystemPrompt: meos?.appendSystemPrompt,
  })) {
    switch (event.type) {
      // session/init carries the model + cwd, but we don't surface it: the trace
      // fills from the model's own reasoning and tool calls within a beat, and the
      // "Running Claude Code…" shimmer covers the gap — a "Claude Code · model ·
      // /path/to/sandbox" line was just noise (and leaked an internal path).
      case "reasoning":
        send({ type: "reasoning", text: event.text });
        break;
      case "tool-call":
        send({
          type: "tool-call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
        });
        break;
      case "tool-result":
        if (!event.isError)
          collectMeosReferences(event.toolName, event.output, sourcesById, pagesBySlug);
        send({
          type: "tool-result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.output,
          isError: event.isError,
        });
        break;
      case "text":
        reply += event.text;
        send({ type: "delta", text: event.text });
        break;
      case "result":
        sawResult = true;
        resultText = event.text;
        if (event.isError) failure = failureMessage(event.subtype, event.text);
        // Some turns speak only through the final result (no streamed text blocks)
        // — stream it now so the live answer matches what gets persisted.
        if (!reply.trim() && event.text) {
          reply += event.text;
          send({ type: "delta", text: event.text });
        }
        if (event.sessionId) ctx.store.setSetting(sessionKey(conversationId), event.sessionId);
        break;
      case "error":
        failure = event.message;
        break;
    }
  }

  // Client disconnected mid-run: the child was killed; persist nothing and leave
  // the (still valid) resume session untouched.
  if (signal?.aborted) return;

  // A resume that produced no result means the stored session is stale/expired —
  // clear it so the next turn in this conversation starts fresh instead of
  // re-resuming a dead id forever.
  if (!sawResult && resumeSessionId) {
    ctx.store.setSetting(sessionKey(conversationId), null);
  }

  const answer = reply.trim() || resultText.trim();
  if (!answer) {
    // Nothing to show — surface the failure (if any) and leave no empty turn behind.
    if (failure) send({ type: "error", message: failure });
    return;
  }

  // The run produced an answer but also failed (e.g. hit the turn limit): keep the
  // partial answer, but flag the truncation rather than passing it off as complete.
  let finalText = answer;
  if (failure) {
    const notice = `\n\n_${failure}_`;
    send({ type: "delta", text: notice });
    finalText = answer + notice;
  }

  // Keep only the references the answer actually leans on (see selectAnswerReferences).
  const { sources, pages } = selectAnswerReferences(answer, sourcesById, pagesBySlug);
  if (sources.length > 0 || pages.length > 0) {
    send({ type: "sources", sources, pages });
  }

  const messageId = ctx.store.addMessage(conversationId, "assistant", finalText);
  // Persist the source documents on the message (same as the in-app chat) so they
  // survive a reload. Pages are live-only, like the traversed graph.
  if (sources.length > 0) {
    ctx.store.linkMessageSources(
      messageId,
      sources.map((s) => s.id),
    );
  }
}

const MAX_AGENT_SOURCES = 8;
const MAX_AGENT_PAGES = 12;

// Boilerplate words in source titles that don't make a title "named" by an answer.
const TITLE_STOPWORDS = new Set([
  "current",
  "draft",
  "final",
  "latest",
  "updated",
  "version",
  "article",
  "intro",
  "introduction",
  "chapter",
  "reading",
  "readings",
  "slides",
  "notes",
  "paper",
  "copy",
]);

/**
 * Distinctive (≥5-letter, non-boilerplate) words from a source title — what an
 * answer would actually echo when it cites the document (e.g. an author surname).
 * Letters only, so "Kraut10-Contribution" yields "kraut", "contribution".
 */
function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 5 && !TITLE_STOPWORDS.has(t));
}

/**
 * True when the answer cites the document. We test only the title's FIRST
 * distinctive token — for academic filenames that's the author surname or lead
 * title word ("Kraut10-Contribution" → "kraut", "Seering_etal_2018" → "seering").
 * Matching any token would let a generic topic word the title happens to share
 * with the answer ("social", "design") count as a citation, which it isn't.
 */
function titleGroundsAnswer(title: string, answerText: string): boolean {
  const lead = titleTokens(title)[0];
  return lead !== undefined && answerText.includes(lead);
}

/**
 * A title's identity ignoring week prefix, version suffix, and extension, so the
 * same reading filed under different weeks (e.g. "W2 - Kraut10-Contribution-current"
 * and "W3 - Kraut10-Contribution-current") collapses to a single reference.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\.(pdf|docx?|md|txt|pages)$/i, "")
    .replace(/^w\d+\s*[-–]\s*/i, "")
    .replace(/[-_\s]+(current|draft|final|latest|updated|v\d+)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface AgentSource {
  id: number;
  title: string;
  path: string | null;
  type?: string;
}
export interface AgentPage {
  name: string;
  slug: string;
  type: string;
}

/**
 * From everything the agent's meOS tools surfaced, keep only what the answer
 * actually leans on — the broad retrieval pool mostly never reaches the reply. A
 * page is kept when the answer names it (its `[[link]]` or its name); a document
 * when the answer cites it (its title's lead token — author/lead word — appears).
 * The same reading filed under different weeks collapses to one. Capped.
 */
export function selectAnswerReferences(
  answer: string,
  sourcesById: Map<number, AgentSource>,
  pagesBySlug: Map<string, AgentPage>,
): { sources: AgentSource[]; pages: AgentPage[] } {
  const answerText = answer.toLowerCase();
  const linkedNames = new Set(
    [...answer.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1]!.trim().toLowerCase()),
  );
  const pages = [...pagesBySlug.values()]
    .filter(
      (p) => linkedNames.has(p.name.toLowerCase()) || answerText.includes(p.name.toLowerCase()),
    )
    .slice(0, MAX_AGENT_PAGES);
  const seenTitles = new Set<string>();
  const sources = [...sourcesById.values()]
    .filter((s) => titleGroundsAnswer(s.title, answerText))
    .filter((s) => {
      const key = normalizeTitle(s.title);
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    })
    .slice(0, MAX_AGENT_SOURCES);
  return { sources, pages };
}

/**
 * Pull the grounding references out of a meOS MCP tool result.
 *
 * Pages come ONLY from `wiki_context` — the page the agent deliberately OPENED to
 * ground its answer. `wiki_search` ENTITIES are exploratory top-K candidates (often
 * tangential — e.g. a reading's authors) and would be noise, so they're skipped.
 *
 * Sources come from BOTH: `wiki_search` returns the query-relevant retrieval (this
 * is where the documents live, since many entities have no directly-linked source
 * of their own), and `wiki_context` adds the opened page's own sources (which carry
 * a `link` rather than a `path`). Best-effort: a result that doesn't parse or match
 * the expected shape is skipped.
 */
export function collectMeosReferences(
  toolName: string,
  output: string,
  sources: Map<number, AgentSource>,
  pages: Map<string, AgentPage>,
): void {
  const bare = toolName.startsWith("mcp__meos__") ? toolName.slice("mcp__meos__".length) : toolName;
  if (bare !== "wiki_search" && bare !== "wiki_context") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const rec = parsed as Record<string, unknown>;

  // The page the agent opened (context only — search entities are noisy candidates).
  if (bare === "wiki_context" && rec.entity && typeof rec.entity === "object") {
    const e = rec.entity as Record<string, unknown>;
    const slug = typeof e.slug === "string" ? e.slug : null;
    const name = typeof e.name === "string" ? e.name : null;
    if (slug && name && !pages.has(slug)) {
      pages.set(slug, { name, slug, type: typeof e.type === "string" ? e.type : "concept" });
    }
  }

  // Sources: both tools return a `sources` array (context uses `link` for `path`).
  for (const raw of Array.isArray(rec.sources) ? rec.sources : []) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const id = typeof s.id === "number" ? s.id : null;
    const title = typeof s.title === "string" ? s.title : null;
    if (id === null || title === null || sources.has(id)) continue;
    const path = typeof s.path === "string" ? s.path : typeof s.link === "string" ? s.link : null;
    sources.set(id, { id, title, path, type: typeof s.type === "string" ? s.type : undefined });
  }
}

/** A human-facing reason for a failed Claude Code run, derived from the CLI's result subtype. */
function failureMessage(subtype: string, text: string): string {
  if (subtype === "error_max_turns") {
    return "Claude Code stopped: it reached the turn limit, so this answer may be incomplete.";
  }
  if (subtype === "error_during_execution") {
    return text.trim() || "Claude Code stopped: an error occurred during the run.";
  }
  return text.trim() || "Claude Code run failed.";
}
