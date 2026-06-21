import { arr, asText, num, obj, str, type Rec } from "./json.js";
import type { ClaudeAgentEvent } from "./types.js";

/**
 * Maps Claude Code CLI `--output-format stream-json --verbose` NDJSON onto the
 * normalized {@link ClaudeAgentEvent} stream. One line in → zero or more events
 * out. Stateful only to correlate a `tool_result` (delivered later, in a
 * `type:"user"` line) back to the name of the `tool_use` that produced it.
 *
 * Stream shape (grounded in real captured sessions): every line is one JSON
 * object with a top-level `type`:
 *  - `system`/`init`  — first line; session id, model, tool list.
 *  - `assistant`      — an Anthropic message under `.message`; `content` blocks
 *                       are `text` | `thinking` | `tool_use`. One line can mix
 *                       several blocks. A model error arrives as a synthetic
 *                       message (`message.model === "<synthetic>"`).
 *  - `user`           — carries `tool_result` blocks (NOT a top-level type),
 *                       correlated by `tool_use_id`.
 *  - `result`         — exactly one, last; terminal status, cost, usage.
 *  - `stream_event`   — only with `--include-partial-messages`; ignored here
 *                       (we don't pass that flag — the consolidated `assistant`
 *                       lines already carry the full text).
 */
export class ClaudeStreamAdapter {
  /** tool_use.id → tool name, so a later tool_result can be labelled. */
  private readonly toolNames = new Map<string, string>();

  push(line: string): ClaudeAgentEvent[] {
    const text = line.trim();
    if (!text) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON noise can leak to stdout (warnings/debug) — ignore it.
      return [];
    }
    const msg = obj(parsed);
    if (!msg) return [];
    switch (msg.type) {
      case "system":
        return this.system(msg);
      case "assistant":
        return this.assistant(msg);
      case "user":
        return this.user(msg);
      case "result":
        return this.result(msg);
      default:
        return [];
    }
  }

  private system(msg: Rec): ClaudeAgentEvent[] {
    if (msg.subtype !== "init") return [];
    return [
      {
        type: "session",
        sessionId: str(msg.session_id) ?? "",
        model: str(msg.model) ?? "",
        tools: arr(msg.tools)
          .map((t) => str(t) ?? "")
          .filter(Boolean),
        cwd: str(msg.cwd) ?? "",
        permissionMode: str(msg.permissionMode) ?? "",
      },
    ];
  }

  private assistant(msg: Rec): ClaudeAgentEvent[] {
    const message = obj(msg.message);
    const agentId = str(msg.parent_tool_use_id) ?? null;

    // The CLI signals a model-level failure (e.g. a 404 on an unavailable model)
    // with a synthetic message whose text is the API error. Surface it as an error.
    if (message && message.model === "<synthetic>") {
      return [
        { type: "error", message: firstText(message.content) ?? "Claude Code returned an error." },
      ];
    }

    const out: ClaudeAgentEvent[] = [];
    for (const raw of arr(message?.content)) {
      const block = obj(raw);
      if (!block) continue;
      if (block.type === "text") {
        const t = str(block.text);
        if (t) out.push({ type: "text", text: t, agentId });
      } else if (block.type === "thinking") {
        const t = str(block.thinking);
        if (t) out.push({ type: "reasoning", text: t, agentId });
      } else if (block.type === "tool_use" || block.type === "server_tool_use") {
        const id = str(block.id);
        if (!id) continue;
        const name = str(block.name) ?? "tool";
        this.toolNames.set(id, name);
        out.push({
          type: "tool-call",
          toolCallId: id,
          toolName: name,
          input: block.input ?? {},
          agentId,
        });
      }
    }
    return out;
  }

  private user(msg: Rec): ClaudeAgentEvent[] {
    const message = obj(msg.message);
    const agentId = str(msg.parent_tool_use_id) ?? null;
    const out: ClaudeAgentEvent[] = [];
    for (const raw of arr(message?.content)) {
      const block = obj(raw);
      if (!block || block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      if (!id) continue;
      out.push({
        type: "tool-result",
        toolCallId: id,
        toolName: this.toolNames.get(id) ?? "tool",
        output: asText(block.content),
        isError: block.is_error === true,
        agentId,
      });
    }
    return out;
  }

  private result(msg: Rec): ClaudeAgentEvent[] {
    return [
      {
        type: "result",
        sessionId: str(msg.session_id) ?? "",
        isError: msg.is_error === true,
        subtype: str(msg.subtype) ?? "",
        text: str(msg.result) ?? "",
        costUsd: num(msg.total_cost_usd) ?? 0,
        numTurns: num(msg.num_turns) ?? 0,
        durationMs: num(msg.duration_ms) ?? 0,
      },
    ];
  }
}

/** The first text block's text, used to surface a synthetic-error message. */
function firstText(content: unknown): string | undefined {
  for (const raw of arr(content)) {
    const block = obj(raw);
    if (block?.type === "text") return str(block.text);
  }
  return undefined;
}
