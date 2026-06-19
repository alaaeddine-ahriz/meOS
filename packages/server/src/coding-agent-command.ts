import fs from "node:fs";
import path from "node:path";
import { runClaudeCodeAgent } from "@meos/core";
import type { AppContext } from "./context.js";

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

function resolveRun(ctx: AppContext, conversationId: number) {
  const settings = ctx.store.getSetting<AgentSettings>(SETTINGS_KEY) ?? {};
  // Default to a dedicated workspace under the data dir — a contained, writable
  // place for the agent (which runs with permissions bypassed) to do its work.
  const cwd = settings.cwd?.trim() || path.join(ctx.config.dataDir, "coding-agent");
  fs.mkdirSync(cwd, { recursive: true });
  const model = settings.model?.trim() || undefined;
  const resumeSessionId = ctx.store.getSetting<string>(sessionKey(conversationId)) ?? undefined;
  return { cwd, model, resumeSessionId };
}

export async function runCodingAgent(
  ctx: AppContext,
  conversationId: number,
  message: string,
  send: Send,
  signal?: AbortSignal,
): Promise<void> {
  const prompt = message.trim();
  const firstTurn = ctx.store.listMessages(conversationId).length === 0;
  ctx.store.addMessage(conversationId, "user", prompt);
  if (firstTurn) ctx.store.setConversationTitle(conversationId, prompt.slice(0, 80));

  const { cwd, model, resumeSessionId } = resolveRun(ctx, conversationId);

  let reply = "";
  let resultText = "";
  let failure: string | null = null;
  let sawResult = false;

  for await (const event of runClaudeCodeAgent({ prompt, cwd, model, resumeSessionId, signal })) {
    switch (event.type) {
      case "session":
        // Open the trace with a line naming the agent so the turn never sits empty.
        send({
          type: "reasoning",
          text: `Claude Code · ${event.model || model || "default"} · ${event.cwd}`,
        });
        break;
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
  ctx.store.addMessage(conversationId, "assistant", finalText);
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
