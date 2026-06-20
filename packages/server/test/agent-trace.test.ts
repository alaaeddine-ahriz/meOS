import { describe, expect, it } from "vitest";
import {
  appendReasoning,
  appendText,
  isMeaningfulTelemetry,
  settleTool,
  toPersistedTrace,
  type TracePart,
} from "../src/coding-agent-command.js";

describe("trace accumulation", () => {
  it("merges consecutive reasoning / text deltas into one step", () => {
    const trace: TracePart[] = [];
    appendReasoning(trace, "think");
    appendReasoning(trace, "ing");
    appendText(trace, "ans");
    appendText(trace, "wer");
    expect(trace).toEqual([
      { kind: "reasoning", text: "thinking" },
      { kind: "text", text: "answer" },
    ]);
  });

  it("settles a tool result onto its pending call by id, then by name", () => {
    const trace: TracePart[] = [];
    trace.push({ kind: "tool", toolCallId: "t1", toolName: "Bash", input: { command: "ls" } });
    trace.push({ kind: "tool", toolName: "Read", input: { file_path: "a.ts" } });

    settleTool(trace, "t1", "Bash", "a\nb", false);
    settleTool(trace, undefined, "Read", "boom", true);

    expect(trace[0]).toMatchObject({ output: "a\nb", isError: false });
    expect(trace[1]).toMatchObject({ output: "boom", isError: true });
  });

  it("drops the live-only toolCallId and caps oversized outputs when persisting", () => {
    const big = "x".repeat(20_000);
    const trace: TracePart[] = [
      {
        kind: "tool",
        toolCallId: "t1",
        toolName: "Bash",
        input: { command: "ls" },
        output: big,
        isError: false,
      },
    ];
    const [persisted] = toPersistedTrace(trace);
    expect(persisted).not.toHaveProperty("toolCallId");
    const output = (persisted as { output: string }).output;
    expect(output.length).toBeLessThan(big.length);
    expect(output.endsWith("…[truncated]")).toBe(true);
  });

  it("treats an all-zero run as having no telemetry", () => {
    expect(isMeaningfulTelemetry({ costUsd: 0, numTurns: 0, durationMs: 0 })).toBe(false);
    expect(isMeaningfulTelemetry({ costUsd: 0, numTurns: 2, durationMs: 0 })).toBe(true);
    expect(isMeaningfulTelemetry({ costUsd: 0.01, numTurns: 0, durationMs: 0 })).toBe(true);
  });
});
