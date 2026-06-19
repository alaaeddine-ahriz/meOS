import { describe, expect, it } from "vitest";
import {
  CodexStreamAdapter,
  GeminiStreamAdapter,
  PlainTextStreamAdapter,
  findOnPath,
  getCodingAgent,
  listAgents,
  type AgentEvent,
} from "../src/coding-agent/index.js";

function run(
  adapter: { push(l: string): AgentEvent[]; flush?(): AgentEvent[] },
  lines: string[],
): AgentEvent[] {
  const out = lines.flatMap((l) => adapter.push(l));
  return [...out, ...(adapter.flush?.() ?? [])];
}

describe("CodexStreamAdapter", () => {
  it("maps thread.started to a session event", () => {
    const events = run(new CodexStreamAdapter(), [`{"type":"thread.started","thread_id":"th_1"}`]);
    expect(events).toEqual([
      { type: "session", sessionId: "th_1", model: "", tools: [], cwd: "", permissionMode: "" },
    ]);
  });

  it("maps a completed agent_message to text and uses it as the result answer", () => {
    const events = run(new CodexStreamAdapter(), [
      `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"2 files"}}`,
      `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`,
    ]);
    expect(events[0]).toEqual({ type: "text", text: "2 files", agentId: null });
    expect(events[1]).toMatchObject({ type: "result", text: "2 files", isError: false });
  });

  it("accepts the legacy assistant_message item type", () => {
    const events = run(new CodexStreamAdapter(), [
      `{"type":"item.completed","item":{"id":"i1","item_type":"assistant_message","text":"hi"}}`,
    ]);
    expect(events).toEqual([{ type: "text", text: "hi", agentId: null }]);
  });

  it("maps reasoning to a reasoning event", () => {
    const events = run(new CodexStreamAdapter(), [
      `{"type":"item.completed","item":{"id":"r1","type":"reasoning","text":"thinking"}}`,
    ]);
    expect(events).toEqual([{ type: "reasoning", text: "thinking", agentId: null }]);
  });

  it("emits a command call on start and correlates its result on completion", () => {
    const events = run(new CodexStreamAdapter(), [
      `{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"ls"}}`,
      `{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls","status":"completed","exit_code":0,"aggregated_output":"a.txt"}}`,
    ]);
    expect(events[0]).toEqual({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "shell",
      input: { command: "ls" },
      agentId: null,
    });
    expect(events[1]).toEqual({
      type: "tool-result",
      toolCallId: "c1",
      toolName: "shell",
      output: "a.txt",
      isError: false,
      agentId: null,
    });
  });

  it("flags a failed command via non-zero exit", () => {
    const events = run(new CodexStreamAdapter(), [
      `{"type":"item.completed","item":{"id":"c2","type":"command_execution","command":"x","exit_code":1,"aggregated_output":"boom"}}`,
    ]);
    // call + result (the call is synthesized on completion when none was emitted earlier)
    expect(events[1]).toMatchObject({ type: "tool-result", isError: true });
  });

  it("maps an mcp_tool_call to a named tool call + result", () => {
    const events = run(new CodexStreamAdapter(), [
      `{"type":"item.completed","item":{"id":"m1","type":"mcp_tool_call","tool_name":"wiki_search","arguments":{"q":"x"},"result":"hit","status":"completed"}}`,
    ]);
    expect(events[0]).toMatchObject({
      type: "tool-call",
      toolName: "wiki_search",
      toolCallId: "m1",
    });
    expect(events[1]).toMatchObject({
      type: "tool-result",
      toolName: "wiki_search",
      output: "hit",
    });
  });

  it("surfaces turn.failed and top-level error as error events", () => {
    expect(
      run(new CodexStreamAdapter(), [`{"type":"turn.failed","error":{"message":"nope"}}`]),
    ).toEqual([{ type: "error", message: "nope" }]);
    expect(run(new CodexStreamAdapter(), [`{"type":"error","message":"fatal"}`])).toEqual([
      { type: "error", message: "fatal" },
    ]);
  });

  it("ignores noise and partial item lifecycle lines without completion", () => {
    expect(run(new CodexStreamAdapter(), ["", "not json", `{"type":"turn.started"}`])).toEqual([]);
  });
});

describe("GeminiStreamAdapter", () => {
  it("maps init to a session event", () => {
    const events = run(new GeminiStreamAdapter(), [
      `{"type":"init","sessionId":"s1","model":"gemini-2.5-pro"}`,
    ]);
    expect(events).toEqual([
      {
        type: "session",
        sessionId: "s1",
        model: "gemini-2.5-pro",
        tools: [],
        cwd: "",
        permissionMode: "",
      },
    ]);
  });

  it("streams assistant delta chunks as text, ignoring user messages", () => {
    const events = run(new GeminiStreamAdapter(), [
      `{"type":"message","role":"user","content":"hi","delta":false}`,
      `{"type":"message","role":"assistant","content":"2 ","delta":true}`,
      `{"type":"message","role":"assistant","content":"files","delta":true}`,
    ]);
    expect(events).toEqual([
      { type: "text", text: "2 ", agentId: null },
      { type: "text", text: "files", agentId: null },
    ]);
  });

  it("does not double-print a final non-delta message after deltas, but keeps it as the answer", () => {
    const events = run(new GeminiStreamAdapter(), [
      `{"type":"message","role":"assistant","content":"hello","delta":true}`,
      `{"type":"message","role":"assistant","content":"hello world","delta":false}`,
      `{"type":"result","stats":{}}`,
    ]);
    expect(events.filter((e) => e.type === "text")).toEqual([
      { type: "text", text: "hello", agentId: null },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "result", text: "hello world" });
  });

  it("correlates tool_use and tool_result by id", () => {
    const events = run(new GeminiStreamAdapter(), [
      `{"type":"tool_use","toolId":"t1","toolName":"search","args":{"q":"x"}}`,
      `{"type":"tool_result","toolId":"t1","output":"result"}`,
    ]);
    expect(events[0]).toMatchObject({ type: "tool-call", toolName: "search", toolCallId: "t1" });
    expect(events[1]).toMatchObject({ type: "tool-result", toolName: "search", output: "result" });
  });

  it("handles a single-object --output-format json line", () => {
    const events = run(new GeminiStreamAdapter(), [`{"response":"the answer","stats":{}}`]);
    expect(events[0]).toEqual({ type: "text", text: "the answer", agentId: null });
    expect(events[1]).toMatchObject({ type: "result", text: "the answer" });
  });

  it("surfaces an error event", () => {
    expect(run(new GeminiStreamAdapter(), [`{"type":"error","message":"bad"}`])).toEqual([
      { type: "error", message: "bad" },
    ]);
  });
});

describe("PlainTextStreamAdapter", () => {
  it("streams each line as text and synthesizes a terminal result on flush", () => {
    const adapter = new PlainTextStreamAdapter();
    const streamed = ["line one", "line two"].flatMap((l) => adapter.push(l));
    expect(streamed).toEqual([
      { type: "text", text: "line one\n", agentId: null },
      { type: "text", text: "line two\n", agentId: null },
    ]);
    const [result] = adapter.flush();
    expect(result).toMatchObject({ type: "result", text: "line one\nline two", isError: false });
  });
});

describe("agent registry + detection", () => {
  it("defaults to Claude Code for an unknown or missing id", () => {
    expect(getCodingAgent(undefined).id).toBe("claude");
    expect(getCodingAgent("nope").id).toBe("claude");
    expect(getCodingAgent("codex").id).toBe("codex");
  });

  it("findOnPath resolves a binary present on PATH and rejects a missing one", () => {
    // `node` is always present in the test runtime.
    expect(findOnPath("node")).not.toBeNull();
    expect(findOnPath("definitely-not-a-real-binary-xyz")).toBeNull();
  });

  it("lists every supported agent, all not-installed when PATH is empty", () => {
    const all = listAgents({ PATH: "" });
    expect(all.map((a) => a.id).sort()).toEqual(["claude", "codex", "copilot", "cursor", "gemini"]);
    expect(all.every((a) => !a.installed)).toBe(true);
    expect(all.every((a) => typeof a.installHint === "string" && a.installHint.length > 0)).toBe(
      true,
    );
  });

  it("marks an agent installed when its binary verifies via --version", () => {
    const dir = makeFakeBin("codex", '#!/bin/sh\necho "codex-cli 0.45.0"\n');
    const codex = listAgents({ PATH: dir }).find((a) => a.id === "codex")!;
    expect(codex).toMatchObject({ id: "codex", label: "Codex", streaming: true, installed: true });
    expect(codex.models.length).toBeGreaterThan(0);
    expect(codex).not.toHaveProperty("run");
  });

  it("rejects a same-named impostor that prints no version (the blog-script `codex` bug)", () => {
    // Mimics the unrelated `codex` blog generator: a bson warning + "not supported".
    const dir = makeFakeBin(
      "codex",
      "#!/bin/sh\necho 'Failed to load c++ bson extension, using pure JS version' 1>&2\necho \"Option '--version' not supported\"\n",
    );
    const codex = listAgents({ PATH: dir }).find((a) => a.id === "codex")!;
    expect(codex.installed).toBe(false);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Create a temp dir holding an executable file named `bin` with the given script body. */
function makeFakeBin(bin: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-agents-"));
  const file = path.join(dir, bin);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return dir;
}
