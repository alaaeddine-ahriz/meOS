import { asText, obj, parseLine, str } from "../json.js";
import type { AgentEvent, StreamAdapter } from "../types.js";

/**
 * Maps Gemini CLI `--output-format stream-json` NDJSON onto the normalized
 * {@link AgentEvent} stream. Event types (per the gemini-cli headless docs):
 *  - `init`        — `sessionId`, `model`.
 *  - `message`     — `role` (`user`/`assistant`), `content`, `delta` (true for
 *                    streamed chunks, false/absent for a complete message).
 *  - `tool_use`    — `toolId`, `toolName`, `args`.
 *  - `tool_result` — `toolId`, `output`.
 *  - `error`       — `message` (warnings and fatal errors alike).
 *  - `result`      — terminal; carries `stats`. (Single-object `--output-format
 *                    json` instead puts the whole answer under `response`.)
 *
 * We stream assistant `delta` chunks as text and keep the final/complete text as
 * the terminal result's answer, so a build that only emits whole messages (no
 * deltas) still surfaces its answer.
 */
export class GeminiStreamAdapter implements StreamAdapter {
  private sessionId = "";
  private streamed = "";
  private finalText = "";
  /** toolId → toolName, so a later tool_result can be labelled. */
  private readonly toolNames = new Map<string, string>();

  push(line: string): AgentEvent[] {
    const msg = parseLine(line);
    if (!msg) return [];

    // Defensive: a single-object `--output-format json` line carries the whole answer.
    if (msg.response !== undefined && msg.type === undefined) {
      const text = str(msg.response) ?? "";
      this.finalText = text;
      return text ? [{ type: "text", text, agentId: null }, this.result()] : [this.result()];
    }

    switch (str(msg.type)) {
      case "init":
        this.sessionId = str(msg.sessionId) ?? str(msg.session_id) ?? "";
        return [
          {
            type: "session",
            sessionId: this.sessionId,
            model: str(msg.model) ?? "",
            tools: [],
            cwd: "",
            permissionMode: "",
          },
        ];
      case "message": {
        if (str(msg.role) !== "assistant") return [];
        const content = str(msg.content) ?? "";
        if (!content) return [];
        if (msg.delta === false) {
          // A complete (non-streamed) message — record it, don't double-print deltas.
          this.finalText = content;
          return this.streamed ? [] : [{ type: "text", text: content, agentId: null }];
        }
        this.streamed += content;
        return [{ type: "text", text: content, agentId: null }];
      }
      case "tool_use": {
        const id = str(msg.toolId) ?? str(msg.tool_id) ?? "";
        const name = str(msg.toolName) ?? str(msg.tool_name) ?? "tool";
        this.toolNames.set(id, name);
        return [
          {
            type: "tool-call",
            toolCallId: id,
            toolName: name,
            input: msg.args ?? {},
            agentId: null,
          },
        ];
      }
      case "tool_result": {
        const id = str(msg.toolId) ?? str(msg.tool_id) ?? "";
        return [
          {
            type: "tool-result",
            toolCallId: id,
            toolName: this.toolNames.get(id) ?? "tool",
            output: asText(msg.output ?? msg.result),
            isError: msg.isError === true || msg.error !== undefined,
            agentId: null,
          },
        ];
      }
      case "error":
        return [
          {
            type: "error",
            message: str(msg.message) ?? str(obj(msg.error)?.message) ?? "Gemini error.",
          },
        ];
      case "result":
        return [this.result()];
      default:
        return [];
    }
  }

  private result(): AgentEvent {
    return {
      type: "result",
      sessionId: this.sessionId,
      isError: false,
      subtype: "success",
      text: this.finalText || this.streamed,
      costUsd: 0,
      numTurns: 0,
      durationMs: 0,
    };
  }
}
