import type { AgentEvent, StreamAdapter } from "../types.js";

/**
 * For agents that can't emit a structured event stream headlessly (today only
 * GitHub Copilot's `-p` mode, which prints plain text): forward each stdout line
 * as a `text` event so the answer still streams, and synthesize the terminal
 * `result` on `flush()`. No reasoning or tool trace is available in this mode.
 */
export class PlainTextStreamAdapter implements StreamAdapter {
  private text = "";

  push(line: string): AgentEvent[] {
    // Preserve line breaks so the reassembled answer keeps its structure.
    const chunk = `${line}\n`;
    this.text += chunk;
    return [{ type: "text", text: chunk, agentId: null }];
  }

  flush(): AgentEvent[] {
    return [
      {
        type: "result",
        sessionId: "",
        isError: false,
        subtype: "success",
        text: this.text.trim(),
        costUsd: 0,
        numTurns: 0,
        durationMs: 0,
      },
    ];
  }
}
