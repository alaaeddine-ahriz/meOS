import { describe, expect, it } from "vitest";
import { buildClaudeArgs } from "../src/coding-agent/index.js";
import { DEFAULT_MODEL } from "../src/coding-agent/types.js";

/** Read the value that follows a flag in the argv (e.g. valueAfter(args, "--model")). */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("buildClaudeArgs", () => {
  it("always runs headless streaming-json with a model and a turn budget", () => {
    const args = buildClaudeArgs({ prompt: "hi", cwd: "/tmp" });
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(valueAfter(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    // The CLI's own default 404s on some installs, so a model is always passed.
    expect(valueAfter(args, "--model")).toBe(DEFAULT_MODEL);
    expect(valueAfter(args, "--permission-mode")).toBe("bypassPermissions");
    expect(valueAfter(args, "--max-turns")).toBe("30");
  });

  it("passes the requested model through", () => {
    const args = buildClaudeArgs({ prompt: "hi", cwd: "/tmp", model: "opus" });
    expect(valueAfter(args, "--model")).toBe("opus");
  });

  it("injects --mcp-config and --append-system-prompt only when provided", () => {
    const bare = buildClaudeArgs({ prompt: "hi", cwd: "/tmp" });
    expect(bare).not.toContain("--mcp-config");
    expect(bare).not.toContain("--append-system-prompt");

    const mcpConfig = JSON.stringify({ mcpServers: { meos: { command: "node", args: ["x.js"] } } });
    const args = buildClaudeArgs({
      prompt: "hi",
      cwd: "/tmp",
      mcpConfig,
      appendSystemPrompt: "use the meos tools",
    });
    expect(valueAfter(args, "--mcp-config")).toBe(mcpConfig);
    expect(valueAfter(args, "--append-system-prompt")).toBe("use the meos tools");
    // Merge semantics: we never pass --strict-mcp-config, so the user's own
    // servers are kept alongside the ones we inject.
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("resumes a prior session when an id is given", () => {
    const args = buildClaudeArgs({ prompt: "hi", cwd: "/tmp", resumeSessionId: "sess-1" });
    expect(valueAfter(args, "--resume")).toBe("sess-1");
  });
});
