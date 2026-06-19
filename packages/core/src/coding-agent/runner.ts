import { ClaudeStreamAdapter } from "./adapter.js";
import { runAgentProcess } from "./spawn.js";
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  type ClaudeAgentEvent,
  type ClaudeRunOptions,
} from "./types.js";

/**
 * Build the `claude` CLI argument vector for a run. Pure (no spawn, no I/O) so
 * the flag wiring — model, MCP config, appended system prompt, resume — can be
 * unit-tested without shelling out.
 */
export function buildClaudeArgs(opts: ClaudeRunOptions): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    opts.permissionMode ?? DEFAULT_PERMISSION_MODE,
    "--model",
    opts.model ?? DEFAULT_MODEL,
    "--max-turns",
    String(opts.maxTurns ?? DEFAULT_MAX_TURNS),
    // Merge our MCP servers with the user's own (no --strict-mcp-config), so the
    // agent gets meOS's wiki/knowledge tools on top of whatever it already has.
    ...(opts.mcpConfig ? ["--mcp-config", opts.mcpConfig] : []),
    ...(opts.appendSystemPrompt ? ["--append-system-prompt", opts.appendSystemPrompt] : []),
    ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
  ];
}

/**
 * Run Claude Code headlessly and yield its run as a normalized event stream.
 *
 * Spawns `claude -p --output-format stream-json --verbose …`, feeds the prompt
 * on stdin (robust to prompts that start with `-`), and reads stdout NDJSON
 * through {@link ClaudeStreamAdapter}. The CLI is shelled out to (not embedded)
 * on purpose, so the user's own Claude Code login and configuration flow through.
 */
export function runClaudeCodeAgent(opts: ClaudeRunOptions): AsyncIterable<ClaudeAgentEvent> {
  return runAgentProcess({
    bin: opts.bin ?? "claude",
    args: buildClaudeArgs(opts),
    cwd: opts.cwd,
    prompt: opts.prompt,
    env: opts.env,
    signal: opts.signal,
    adapter: new ClaudeStreamAdapter(),
    label: "Claude Code",
    installHint: "Install it with `npm i -g @anthropic-ai/claude-code` and make sure it's on PATH.",
    promptOnStdin: true,
  });
}
