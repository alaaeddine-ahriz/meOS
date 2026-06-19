/**
 * The local coding-agent runner: spawns an external coding-agent CLI (Claude
 * Code today) in headless streaming-JSON mode and surfaces its run as a typed
 * event stream the chat can render the way an AI IDE does — reasoning, each tool
 * call (Bash, Read, Edit…) with its result, and the text it emits between steps.
 *
 * The CLI is shelled out to (not embedded) on purpose, the same way {@link
 * ../../server git sync} shells out to system `git`: the user's own Claude Code
 * login and configuration flow straight through.
 */

/** Default model. The CLI's own default 404s on some installed versions, so we always pass `--model`. */
export const DEFAULT_MODEL = "claude-sonnet-4-5";
/** Headless runs have no TTY to approve tool use, so the only workable mode is bypass. */
export const DEFAULT_PERMISSION_MODE = "bypassPermissions";
/** Tool-loop budget for a single chat turn — generous enough for a real coding task. */
export const DEFAULT_MAX_TURNS = 30;

export interface ClaudeRunOptions {
  /** The user's instruction for this turn (fed to the CLI on stdin). */
  prompt: string;
  /** Working directory the agent reads and edits files in. */
  cwd: string;
  /** Model id passed as `--model`. Defaults to {@link DEFAULT_MODEL}. */
  model?: string;
  /** Resume a prior CLI session (`--resume <id>`) so a conversation stays coherent across turns. */
  resumeSessionId?: string;
  /** `--max-turns`. Defaults to {@link DEFAULT_MAX_TURNS}. */
  maxTurns?: number;
  /** `--permission-mode`. Defaults to {@link DEFAULT_PERMISSION_MODE}. */
  permissionMode?: string;
  /**
   * MCP servers to expose to the agent, as the JSON Claude Code's `--mcp-config`
   * accepts (`{ "mcpServers": { … } }`). Passed inline (not `--strict-mcp-config`),
   * so it MERGES with the user's own configured servers rather than replacing
   * them. meOS uses this to inject its own wiki/knowledge MCP.
   */
  mcpConfig?: string;
  /**
   * Text appended to the agent's system prompt (`--append-system-prompt`) — meOS
   * uses it to tell the agent about the meOS tools it just injected.
   */
  appendSystemPrompt?: string;
  /** Abort the run (kills the child) — wired to client disconnect. */
  signal?: AbortSignal;
  /** Binary to spawn. Defaults to `claude` (resolved on PATH). */
  bin?: string;
  /** Extra environment overlaid on the inherited process env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * A normalized event from a coding-agent run. Adapters (Claude Code today, Codex
 * later) map their provider-specific stream onto this single shape, so the chat
 * pipeline renders any agent identically. `agentId` is null for the main agent
 * and a parent tool-call id for a sub-agent lane (spawned via the `Task` tool).
 */
export type ClaudeAgentEvent =
  | {
      type: "session";
      sessionId: string;
      model: string;
      tools: string[];
      cwd: string;
      permissionMode: string;
    }
  | { type: "reasoning"; text: string; agentId: string | null }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
      agentId: string | null;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: string;
      isError: boolean;
      agentId: string | null;
    }
  | { type: "text"; text: string; agentId: string | null }
  | {
      type: "result";
      sessionId: string;
      isError: boolean;
      subtype: string;
      text: string;
      costUsd: number;
      numTurns: number;
      durationMs: number;
    }
  | { type: "error"; message: string };
