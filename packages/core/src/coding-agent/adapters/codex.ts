import { asText, num, obj, parseLine, str, type Rec } from "../json.js";
import type { AgentEvent, StreamAdapter } from "../types.js";

/**
 * Maps OpenAI Codex CLI `codex exec --json` JSONL onto the normalized {@link
 * AgentEvent} stream. The schema (per the Codex docs / `app-server` JSON schema):
 *  - `thread.started`  — first line; `thread_id` is the resumable session id.
 *  - `turn.started` / `turn.completed` (carries `usage`) / `turn.failed` (`error`).
 *  - `item.started` / `item.updated` / `item.completed` — each wraps an `item`
 *    whose `type` (older builds: `item_type`) is one of `agent_message`,
 *    `reasoning`, `command_execution`, `file_edit`, `mcp_tool_call`, `web_search`,
 *    `todo_list`/`plan`. Items keep a stable `id` across their lifecycle.
 *  - `error` — a fatal top-level error.
 *
 * Stream nuance: assistant text + tool calls/results stream as `item.completed`
 * lines; the run's final answer is the last `agent_message`. We surface tool
 * calls as soon as an item appears (started/updated) so the trace shows the call
 * before its result, and synthesize the terminal `result` from `turn.completed`.
 */
export class CodexStreamAdapter implements StreamAdapter {
  private threadId = "";
  /** Last assistant text — the run's answer, used as the terminal result text. */
  private lastAgentText = "";
  /** Item ids we've already emitted a `tool-call` for, so completion only adds the result. */
  private readonly calledIds = new Set<string>();

  push(line: string): AgentEvent[] {
    const msg = parseLine(line);
    if (!msg) return [];
    const type = str(msg.type);
    switch (type) {
      case "thread.started": {
        this.threadId = str(msg.thread_id) ?? str(msg.session_id) ?? "";
        return [
          {
            type: "session",
            sessionId: this.threadId,
            model: "",
            tools: [],
            cwd: "",
            permissionMode: "",
          },
        ];
      }
      case "item.started":
      case "item.updated":
        return this.item(obj(msg.item), false);
      case "item.completed":
        return this.item(obj(msg.item), true);
      case "turn.completed":
        return [this.result()];
      case "turn.failed": {
        const error = obj(msg.error);
        return [{ type: "error", message: str(error?.message) ?? "Codex turn failed." }];
      }
      case "error":
        return [{ type: "error", message: str(msg.message) ?? "Codex returned an error." }];
      default:
        return [];
    }
  }

  /** itemType across builds: prefer `type`, fall back to legacy `item_type`. */
  private item(item: Rec | null, completed: boolean): AgentEvent[] {
    if (!item) return [];
    const kind = str(item.type) ?? str(item.item_type);
    const id = str(item.id) ?? "";
    switch (kind) {
      case "agent_message":
      case "assistant_message": {
        if (!completed) return [];
        const text = str(item.text) ?? str(item.message) ?? "";
        if (!text) return [];
        this.lastAgentText = text;
        return [{ type: "text", text, agentId: null }];
      }
      case "reasoning": {
        if (!completed) return [];
        const text = str(item.text) ?? str(item.summary) ?? "";
        return text ? [{ type: "reasoning", text, agentId: null }] : [];
      }
      case "command_execution":
        return this.toolItem(
          id,
          "shell",
          { command: str(item.command) ?? "" },
          item,
          completed,
          () => ({
            output: str(item.aggregated_output) ?? str(item.output) ?? "",
            isError: str(item.status) === "failed" || (num(item.exit_code) ?? 0) !== 0,
          }),
        );
      case "mcp_tool_call": {
        const name = str(item.tool_name) ?? str(item.tool) ?? "tool";
        const input = "input" in item ? item.input : item.arguments;
        return this.toolItem(id, name, input, item, completed, () => ({
          output: asText(item.result ?? item.output),
          isError: str(item.status) === "failed",
        }));
      }
      case "web_search":
        return this.toolItem(
          id,
          "web_search",
          { query: str(item.query) ?? "" },
          item,
          completed,
          () => ({
            output: asText(item.results ?? item.result),
            isError: false,
          }),
        );
      case "file_edit":
      case "patch_apply": {
        // Edits arrive whole; show one call + result pair on completion.
        if (!completed) return [];
        const input = { path: str(item.path) ?? "", action: str(item.action) ?? "update" };
        return [
          { type: "tool-call", toolCallId: id, toolName: "edit", input, agentId: null },
          {
            type: "tool-result",
            toolCallId: id,
            toolName: "edit",
            output: asText(item.content ?? item.diff ?? `${input.action} ${input.path}`),
            isError: str(item.status) === "failed",
            agentId: null,
          },
        ];
      }
      default:
        return [];
    }
  }

  /**
   * Emit a tool-call the first time an item appears, then a tool-result when it
   * completes — correlated by the item's stable id.
   */
  private toolItem(
    id: string,
    name: string,
    input: unknown,
    item: Rec,
    completed: boolean,
    result: () => { output: string; isError: boolean },
  ): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (id && !this.calledIds.has(id)) {
      this.calledIds.add(id);
      out.push({ type: "tool-call", toolCallId: id, toolName: name, input, agentId: null });
    }
    if (completed) {
      const r = result();
      out.push({
        type: "tool-result",
        toolCallId: id,
        toolName: name,
        output: r.output,
        isError: r.isError,
        agentId: null,
      });
    }
    return out;
  }

  private result(): AgentEvent {
    return {
      type: "result",
      sessionId: this.threadId,
      isError: false,
      subtype: "success",
      text: this.lastAgentText,
      costUsd: 0,
      numTurns: 0,
      durationMs: 0,
    };
  }
}
