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
 * Claude Code's built-in clarifying-question tool. Headless it is a TRAP: it's in
 * the tool list and the model reaches for it over any MCP tool, but with no TTY it
 * auto-resolves to empty answers in ~37ms (anthropics/claude-code#50728) — the
 * user is never asked. We disable it so the model uses meOS's `ask_user` MCP tool,
 * which actually round-trips a question to the chat UI and back.
 */
const DISALLOWED_TOOLS = ["AskUserQuestion"];

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
    // Remove the dead built-in ask tool so meOS's MCP `ask_user` wins (see above).
    "--disallowedTools",
    DISALLOWED_TOOLS.join(","),
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
    // Give MCP tool calls room to block on a human: meOS's `ask_user` long-polls
    // until the user answers. Claude's default MCP tool timeout is only 60s, and
    // headless it does NOT extend on progress notifications (claude-code#58687) —
    // it's a hard wall-clock limit — but MCP_TOOL_TIMEOUT (ms) IS honored in `-p`
    // mode, so it's the real lever. meOS caps the wait server-side (~270s) and
    // returns a "timeout" result before this 10-min ceiling, so the tool always
    // resolves cleanly first; the ceiling is just generous headroom.
    env: { MCP_TOOL_TIMEOUT: "600000", ...opts.env },
    signal: opts.signal,
    adapter: new ClaudeStreamAdapter(),
    label: "Claude Code",
    installHint: "Install it with `npm i -g @anthropic-ai/claude-code` and make sure it's on PATH.",
    promptOnStdin: true,
  });
}
