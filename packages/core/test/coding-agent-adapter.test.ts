import { describe, expect, it } from "vitest";
import { ClaudeStreamAdapter, type ClaudeAgentEvent } from "../src/coding-agent/index.js";

// Real lines captured from `claude … --output-format stream-json --verbose`
// (Claude Code v1.0.61). Trimmed where noted; shapes are verbatim.
const SESSION = "d667165d-479a-4bbd-973c-a60892c30178";
const INIT = `{"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"${SESSION}","tools":["Bash","Read","Edit"],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"bypassPermissions","apiKeySource":"none"}`;
const ASSISTANT_TEXT = `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"2 files"}],"usage":{"output_tokens":1}},"parent_tool_use_id":null,"session_id":"${SESSION}"}`;
const ASSISTANT_TOOL = `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_2","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_A","name":"Bash","input":{"command":"ls","description":"List files"},"caller":{"type":"direct"}}]},"parent_tool_use_id":null,"session_id":"${SESSION}"}`;
const USER_RESULT = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_A","type":"tool_result","content":"a.txt\\nb.txt","is_error":false}]},"parent_tool_use_id":null,"session_id":"${SESSION}"}`;
const RESULT = `{"type":"result","subtype":"success","is_error":false,"duration_ms":6809,"num_turns":3,"result":"2 files","session_id":"${SESSION}","total_cost_usd":0.0462}`;

/** Feed every line through one adapter and collect the flat event stream. */
function run(lines: string[]): ClaudeAgentEvent[] {
  const adapter = new ClaudeStreamAdapter();
  return lines.flatMap((line) => adapter.push(line));
}

describe("ClaudeStreamAdapter", () => {
  it("maps system/init to a session event", () => {
    const [event] = run([INIT]);
    expect(event).toEqual({
      type: "session",
      sessionId: SESSION,
      model: "claude-haiku-4-5",
      tools: ["Bash", "Read", "Edit"],
      cwd: "/tmp/x",
      permissionMode: "bypassPermissions",
    });
  });

  it("maps an assistant text block to a text event", () => {
    expect(run([ASSISTANT_TEXT])).toEqual([{ type: "text", text: "2 files", agentId: null }]);
  });

  it("maps a thinking block to a reasoning event", () => {
    const line = `{"type":"assistant","message":{"model":"m","content":[{"type":"thinking","thinking":"hmm","signature":"s"}]},"parent_tool_use_id":null}`;
    expect(run([line])).toEqual([{ type: "reasoning", text: "hmm", agentId: null }]);
  });

  it("emits a tool-call and correlates the later tool-result by id and name", () => {
    const events = run([ASSISTANT_TOOL, USER_RESULT]);
    expect(events[0]).toEqual({
      type: "tool-call",
      toolCallId: "toolu_A",
      toolName: "Bash",
      input: { command: "ls", description: "List files" },
      agentId: null,
    });
    expect(events[1]).toEqual({
      type: "tool-result",
      toolCallId: "toolu_A",
      toolName: "Bash", // recovered from the earlier tool_use, not present on the result line
      output: "a.txt\nb.txt",
      isError: false,
      agentId: null,
    });
  });

  it("falls back to a generic name when a tool-result has no matching tool-call", () => {
    const [event] = run([USER_RESULT]); // no preceding ASSISTANT_TOOL
    expect(event).toMatchObject({ type: "tool-result", toolName: "tool", toolCallId: "toolu_A" });
  });

  it("joins array tool-result content into text", () => {
    const line = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t","type":"tool_result","content":[{"type":"text","text":"one"},{"type":"text","text":"two"}],"is_error":false}]}}`;
    const [event] = run([line]);
    expect(event).toMatchObject({ type: "tool-result", output: "one\ntwo" });
  });

  it("flags a failed tool result", () => {
    const line = `{"type":"user","message":{"content":[{"tool_use_id":"t","type":"tool_result","content":"boom","is_error":true}]}}`;
    expect(run([line])[0]).toMatchObject({ type: "tool-result", isError: true });
  });

  it("maps result to a terminal result event", () => {
    expect(run([RESULT])).toEqual([
      {
        type: "result",
        sessionId: SESSION,
        isError: false,
        subtype: "success",
        text: "2 files",
        costUsd: 0.0462,
        numTurns: 3,
        durationMs: 6809,
      },
    ]);
  });

  it("surfaces a synthetic-error assistant (e.g. model 404) as an error event", () => {
    const line = `{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"API Error: 404 not_found_error"}]},"parent_tool_use_id":null}`;
    expect(run([line])).toEqual([{ type: "error", message: "API Error: 404 not_found_error" }]);
  });

  it("attributes sub-agent lanes via parent_tool_use_id", () => {
    const line = `{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"sub"}]},"parent_tool_use_id":"toolu_parent"}`;
    expect(run([line])).toEqual([{ type: "text", text: "sub", agentId: "toolu_parent" }]);
  });

  it("ignores blank lines, non-JSON noise, and partial stream_event lines", () => {
    expect(
      run(["", "  ", "not json", `{"type":"stream_event","event":{"type":"message_start"}}`]),
    ).toEqual([]);
  });

  it("handles a full session in order", () => {
    const kinds = run([INIT, ASSISTANT_TOOL, USER_RESULT, ASSISTANT_TEXT, RESULT]).map(
      (e) => e.type,
    );
    expect(kinds).toEqual(["session", "tool-call", "tool-result", "text", "result"]);
  });
});
