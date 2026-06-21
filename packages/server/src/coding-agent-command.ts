import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  diffSnapshots,
  getCodingAgent,
  snapshotDir,
  type AgentTracePart,
  type DirSnapshot,
  type MessageAgentMeta,
} from "@meos/core";
import { registerAskOperation, unregisterAskOperation } from "./ask-registry.js";
import { buildMeosMcp } from "./meos-mcp.js";
import type { AppContext } from "./context.js";

/**
 * Agent mode: route a chat turn to one of the user's local coding agents (Claude
 * Code, Codex, Cursor, Gemini, Copilot) instead of the knowledge-base assistant.
 * The run's reasoning, tool calls, and answer are forwarded over the SAME SSE
 * frame vocabulary the chat already speaks (`reasoning` / `tool-call` /
 * `tool-result` / `delta`), so the existing chat UI renders any agent with no new
 * components. The conversation is persisted like any other (user turn + final
 * answer), so agent turns survive a reload; the CLI session id is remembered per
 * conversation AND per agent so follow-up turns resume the right session.
 */

type Send = (event: Record<string, unknown>) => void;

interface AgentSettings {
  /** Working directory the agent operates in. Defaults to a sandbox under the data dir. */
  cwd?: string;
  /** Model id. */
  model?: string;
}

const SETTINGS_KEY = "coding-agent";
const sessionKey = (conversationId: number, agentId: string) =>
  `coding-agent:session:${agentId}:${conversationId}`;

/** Override the per-turn model with one supplied by the request, else the stored default. */
function resolveRun(
  ctx: AppContext,
  conversationId: number,
  agentId: string,
  modelOverride?: string,
) {
  const settings = ctx.store.getSetting<AgentSettings>(SETTINGS_KEY) ?? {};
  // Default to a dedicated workspace under the data dir — a contained, writable
  // place for the agent (which runs with permissions bypassed) to do its work.
  const cwd = settings.cwd?.trim() || path.join(ctx.config.dataDir, "coding-agent");
  fs.mkdirSync(cwd, { recursive: true });
  const model = modelOverride?.trim() || settings.model?.trim() || undefined;
  const resumeSessionId =
    ctx.store.getSetting<string>(sessionKey(conversationId, agentId)) ?? undefined;
  return { cwd, model, resumeSessionId };
}

/**
 * Max chars of a single tool output we persist. The live trace streams the full
 * text to the client; persistence caps it so a multi-megabyte Bash/Read dump
 * doesn't bloat the DB and slow every later reload of the conversation.
 */
const MAX_PERSISTED_OUTPUT = 16_000;

/**
 * A trace step during accumulation — the persisted {@link AgentTracePart} plus a
 * live-only `toolCallId` so a `tool-result` can be matched back to its call. The
 * server rebuilds the same chronological timeline the web client renders live, so
 * a reload restores reasoning → tool → answer exactly as it streamed.
 */
export type TracePart =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolCallId?: string;
      toolName: string;
      input: unknown;
      output?: unknown;
      isError?: boolean;
    };

/** Merge a reasoning delta into the trailing reasoning step, or open a new one. */
export function appendReasoning(trace: TracePart[], text: string): void {
  const last = trace[trace.length - 1];
  if (last?.kind === "reasoning") last.text += text;
  else trace.push({ kind: "reasoning", text });
}

/** Merge an answer-text delta into the trailing text step, or open a new one — so
 * a run of prose stays one block but a tool call between two blocks splits them. */
export function appendText(trace: TracePart[], text: string): void {
  const last = trace[trace.length - 1];
  if (last?.kind === "text") last.text += text;
  else trace.push({ kind: "text", text });
}

/** Attach a tool result to its pending call (matched by id, else by name). */
export function settleTool(
  trace: TracePart[],
  toolCallId: string | undefined,
  toolName: string,
  output: unknown,
  isError: boolean,
): void {
  for (let i = trace.length - 1; i >= 0; i--) {
    const part = trace[i]!;
    if (part.kind !== "tool" || part.output !== undefined) continue;
    const matches = toolCallId ? part.toolCallId === toolCallId : part.toolName === toolName;
    if (matches) {
      part.output = output;
      part.isError = isError;
      return;
    }
  }
}

/** Strip the live-only `toolCallId` and cap oversized tool outputs, yielding the
 * reload-safe trace to persist on the message. */
export function toPersistedTrace(trace: TracePart[]): AgentTracePart[] {
  return trace.map((part) => {
    if (part.kind !== "tool") return part;
    let output = part.output;
    if (typeof output === "string" && output.length > MAX_PERSISTED_OUTPUT) {
      output = `${output.slice(0, MAX_PERSISTED_OUTPUT)}\n…[truncated]`;
    }
    return {
      kind: "tool",
      toolName: part.toolName,
      input: part.input,
      output,
      isError: part.isError,
    };
  });
}

/** Telemetry worth surfacing — only Claude Code reports non-zero today, so a run
 * of all-zeros (Codex/Gemini/Copilot) is treated as "no telemetry" and hidden. */
export function isMeaningfulTelemetry(t: {
  costUsd: number;
  numTurns: number;
  durationMs: number;
}): boolean {
  return t.costUsd > 0 || t.numTurns > 0 || t.durationMs > 0;
}

/**
 * The result of one agent run, returned for non-interactive callers (scheduled
 * tasks) that need to record how it went. The chat route ignores it — its UX is
 * driven entirely by the streamed SSE frames.
 */
export interface AgentRunOutcome {
  /** `ok` = produced an answer; `empty` = nothing to show; `error`/`aborted` = failed/cancelled. */
  status: "ok" | "empty" | "error" | "aborted";
  /** The assistant message persisted for this run, if one was. */
  messageId: number | null;
  /** A human-facing failure reason (turn limit, run error), if any. */
  failure: string | null;
  /** The run's cost/turns/duration, if the agent reported it. */
  telemetry: { costUsd: number; numTurns: number; durationMs: number } | null;
  /** How many files the run touched in its workspace. */
  fileCount: number;
}

export async function runCodingAgent(
  ctx: AppContext,
  conversationId: number,
  message: string,
  send: Send,
  signal?: AbortSignal,
  model?: string,
  agentId?: string,
): Promise<AgentRunOutcome> {
  const prompt = message.trim();
  const firstTurn = ctx.store.listMessages(conversationId).length === 0;
  ctx.store.addMessage(conversationId, "user", prompt);
  if (firstTurn) ctx.store.setConversationTitle(conversationId, prompt.slice(0, 80));

  // Pick the requested agent (defaults to Claude Code — the original behaviour).
  const agent = getCodingAgent(agentId);
  const {
    cwd,
    model: runModel,
    resumeSessionId,
  } = resolveRun(ctx, conversationId, agent.id, model);
  // A per-run id the agent's `ask_user` tool quotes back so a mid-run question
  // reaches THIS chat stream; unregistered in `finally` so late answers drop.
  const op = randomUUID();
  // Give the agent meOS's own wiki/knowledge tools, pointed at this server.
  const meos = buildMeosMcp(ctx.config.server.port, op);
  registerAskOperation(op, send, signal);

  // Snapshot the workspace before the run so we can diff it afterwards into the
  // list of files the agent created/edited/removed (agent-neutral file tracking).
  const beforeSnapshot: DirSnapshot = snapshotDir(cwd);

  let reply = "";
  let resultText = "";
  let failure: string | null = null;
  let sawResult = false;
  // The run's chronological trace (reasoning → tool → answer text), accumulated as
  // events arrive and persisted on the message so a reload restores the timeline.
  const trace: TracePart[] = [];
  // The run's cost/turns/duration, from the terminal `result` event (see below).
  let telemetry: { costUsd: number; numTurns: number; durationMs: number } | null = null;
  // The wiki pages + source documents the agent consulted through its meOS tools
  // (wiki_search / wiki_context) — surfaced under the answer like the chat's own
  // citations, so the user can see (and open) what grounded the reply.
  const sourcesById = new Map<number, AgentSource>();
  const pagesBySlug = new Map<string, AgentPage>();

  // Stream a chunk of answer text: keep the live delta, the accumulated reply, and
  // the persisted trace in lockstep so what the client sees matches what's saved.
  const emitText = (text: string) => {
    reply += text;
    appendText(trace, text);
    send({ type: "delta", text });
  };

  try {
    for await (const event of agent.run({
      prompt,
      cwd,
      model: runModel,
      // Only resume when this agent supports it (e.g. Gemini's headless mode can't).
      resumeSessionId: agent.supportsResume ? resumeSessionId : undefined,
      signal,
      mcpServers: meos?.servers,
      systemPrompt: meos?.systemPrompt,
    })) {
      switch (event.type) {
        // session/init carries the model + cwd, but we don't surface it: the trace
        // fills from the model's own reasoning and tool calls within a beat, and the
        // "Running Claude Code…" shimmer covers the gap — a "Claude Code · model ·
        // /path/to/sandbox" line was just noise (and leaked an internal path).
        case "reasoning":
          appendReasoning(trace, event.text);
          send({ type: "reasoning", text: event.text });
          break;
        case "tool-call":
          trace.push({
            kind: "tool",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
          });
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
          settleTool(trace, event.toolCallId, event.toolName, event.output, event.isError);
          send({
            type: "tool-result",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            output: event.output,
            isError: event.isError,
          });
          break;
        case "text":
          emitText(event.text);
          break;
        case "result":
          sawResult = true;
          resultText = event.text;
          if (event.isError) failure = failureMessage(agent.label, event.subtype, event.text);
          // Some turns speak only through the final result (no streamed text blocks)
          // — stream it now so the live answer matches what gets persisted.
          if (!reply.trim() && event.text) emitText(event.text);
          // The run's cost/turns/duration. Surface it as a footer (and persist it)
          // only when it's real — the CLIs that don't report leave it all-zero.
          telemetry = {
            costUsd: event.costUsd,
            numTurns: event.numTurns,
            durationMs: event.durationMs,
          };
          if (isMeaningfulTelemetry(telemetry)) {
            send({ type: "run-telemetry", ...telemetry });
          }
          if (event.sessionId)
            ctx.store.setSetting(sessionKey(conversationId, agent.id), event.sessionId);
          break;
        case "error":
          failure = event.message;
          break;
      }
    }
  } finally {
    // The run is over: no more `ask_user` calls can arrive, and any question still
    // open (e.g. the user never answered) is resolved as cancelled.
    unregisterAskOperation(op);
  }

  // Client disconnected mid-run: the child was killed; persist nothing and leave
  // the (still valid) resume session untouched.
  if (signal?.aborted) {
    return { status: "aborted", messageId: null, failure, telemetry, fileCount: 0 };
  }

  // Diff the workspace against the pre-run snapshot — the files this run created,
  // edited, or removed. Surfaced live under the answer and persisted on the message.
  const filesChanged = diffSnapshots(beforeSnapshot, snapshotDir(cwd));
  if (filesChanged.length > 0) {
    send({ type: "files-changed", files: filesChanged });
  }

  // A resume that produced no result means the stored session is stale/expired —
  // clear it so the next turn in this conversation starts fresh instead of
  // re-resuming a dead id forever.
  if (!sawResult && resumeSessionId) {
    ctx.store.setSetting(sessionKey(conversationId, agent.id), null);
  }

  const answer = reply.trim() || resultText.trim();
  if (!answer) {
    // Nothing to show — surface the failure (if any) and leave no empty turn behind.
    if (failure) send({ type: "error", message: failure });
    return {
      status: failure ? "error" : "empty",
      messageId: null,
      failure,
      telemetry,
      fileCount: filesChanged.length,
    };
  }

  // The run produced an answer but also failed (e.g. hit the turn limit): keep the
  // partial answer, but flag the truncation rather than passing it off as complete.
  let finalText = answer;
  if (failure) {
    const notice = `\n\n_${failure}_`;
    appendText(trace, notice);
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
  // Persist the run's trace, telemetry, and file changes so reopening the
  // conversation rebuilds the IDE-style timeline — not just the final answer.
  const meta: MessageAgentMeta = { trace: toPersistedTrace(trace) };
  if (telemetry && isMeaningfulTelemetry(telemetry)) meta.telemetry = telemetry;
  if (filesChanged.length > 0) meta.filesChanged = filesChanged;
  ctx.store.saveMessageAgentMeta(messageId, meta);

  // A produced answer is a success even if the run also hit a soft limit (the
  // truncation is noted in the message); `failure` is carried through for the
  // caller's run log.
  return { status: "ok", messageId, failure, telemetry, fileCount: filesChanged.length };
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

/** A human-facing reason for a failed agent run, derived from the CLI's result subtype. */
function failureMessage(label: string, subtype: string, text: string): string {
  if (subtype === "error_max_turns") {
    return `${label} stopped: it reached the turn limit, so this answer may be incomplete.`;
  }
  if (subtype === "error_during_execution") {
    return text.trim() || `${label} stopped: an error occurred during the run.`;
  }
  return text.trim() || `${label} run failed.`;
}
