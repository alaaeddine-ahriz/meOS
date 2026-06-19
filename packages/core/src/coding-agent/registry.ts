import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeStreamAdapter } from "./adapter.js";
import { CodexStreamAdapter } from "./adapters/codex.js";
import { GeminiStreamAdapter } from "./adapters/gemini.js";
import { PlainTextStreamAdapter } from "./adapters/text.js";
import { runClaudeCodeAgent } from "./runner.js";
import { runAgentProcess } from "./spawn.js";
import type { AgentEvent, CodingAgentDefinition, McpServerSpec } from "./types.js";

/**
 * The catalog of coding agents meOS can drive in chat. Each entry is fully
 * self-describing: its binary (probed on PATH for detection), the models it
 * offers, and a `run` that translates the neutral {@link AgentRunInput} into that
 * CLI's argv + MCP wiring + stream adapter. Adding an agent means adding one
 * entry here (and, if its stream is novel, one adapter) — nothing else changes.
 *
 * Only Claude Code is verified end-to-end against a live CLI; the others are
 * built from each CLI's published headless interface. Their flag sets and model
 * ids should be re-checked against the installed version, and the model lists
 * are deliberately short — they're a starting point, not an exhaustive catalog.
 */

/** Compose the meOS tool guidance with the user's prompt for agents lacking an append-system-prompt flag. */
function withGuidance(prompt: string, systemPrompt?: string): string {
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
}

/**
 * A `--model`-style flag, OMITTED for the `auto` sentinel (and when empty) so the
 * CLI/signed-in account picks its own current default. This keeps agent mode
 * working even as provider model ids drift — no CLI exposes a model-list command
 * to enumerate them (all open feature requests as of early 2026), so the picker's
 * named options are curated, with `auto` as the drift-proof default.
 */
function modelFlag(flag: string, model: string | undefined, fallback: string): string[] {
  const m = (model ?? fallback).trim();
  return !m || m === "auto" ? [] : [flag, m];
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function hasServers(
  servers?: Record<string, McpServerSpec>,
): servers is Record<string, McpServerSpec> {
  return !!servers && Object.keys(servers).length > 0;
}

/** Wrap setup that may throw so a failure surfaces as a terminal error event, not an unhandled throw. */
async function* guardedRun(
  setup: () => void,
  body: () => AsyncIterable<AgentEvent>,
  label: string,
): AsyncIterable<AgentEvent> {
  try {
    setup();
  } catch (error) {
    yield {
      type: "error",
      message: `Failed to prepare ${label}: ${error instanceof Error ? error.message : String(error)}`,
    };
    return;
  }
  yield* body();
}

const CLAUDE: CodingAgentDefinition = {
  id: "claude",
  label: "Claude Code",
  bin: "claude",
  installHint: "Install it with `npm i -g @anthropic-ai/claude-code` and make sure it's on PATH.",
  // Full ids, not bare aliases: the installed CLI forwards aliases verbatim and the API 404s.
  models: [
    { value: "claude-opus-4-8", label: "Opus" },
    { value: "claude-sonnet-4-6", label: "Sonnet" },
    { value: "claude-haiku-4-5", label: "Haiku" },
  ],
  defaultModel: "claude-sonnet-4-6",
  streaming: true,
  supportsResume: true,
  run(input) {
    // Claude has native --mcp-config (merging) and --append-system-prompt, so it
    // needs no on-disk config: reuse the verified runner directly.
    return runClaudeCodeAgent({
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model,
      resumeSessionId: input.resumeSessionId,
      signal: input.signal,
      bin: input.bin ?? this.bin,
      mcpConfig: hasServers(input.mcpServers)
        ? JSON.stringify({ mcpServers: input.mcpServers })
        : undefined,
      appendSystemPrompt: input.systemPrompt,
    });
  },
};

const CODEX: CodingAgentDefinition = {
  id: "codex",
  label: "Codex",
  bin: "codex",
  installHint: "Install it with `npm i -g @openai/codex` and run `codex login`.",
  models: [
    { value: "auto", label: "Auto" },
    { value: "gpt-5-codex", label: "GPT-5 Codex" },
    { value: "gpt-5", label: "GPT-5" },
  ],
  defaultModel: "auto",
  streaming: true,
  supportsResume: true,
  run(input) {
    const env: NodeJS.ProcessEnv = {};
    const setup = () => {
      // Codex has no per-invocation MCP flag: it reads ~/.codex/config.toml. We
      // inject meOS's servers without touching the user's config by pointing
      // CODEX_HOME at a meOS-owned home seeded with a symlink to their auth — but
      // only when that auth exists, since a home without it isn't logged in. If
      // it doesn't, we run against the real home tool-less (still a working agent).
      if (!hasServers(input.mcpServers)) return;
      const realHome = path.join(os.homedir(), ".codex");
      const realAuth = path.join(realHome, "auth.json");
      if (!fs.existsSync(realAuth)) return;
      const home = path.join(input.cwd, ".codex-home");
      fs.mkdirSync(home, { recursive: true });
      const linkedAuth = path.join(home, "auth.json");
      try {
        if (fs.existsSync(linkedAuth)) fs.rmSync(linkedAuth);
        fs.symlinkSync(realAuth, linkedAuth);
      } catch {
        fs.copyFileSync(realAuth, linkedAuth); // Windows / no-symlink fallback
      }
      fs.writeFileSync(path.join(home, "config.toml"), codexConfigToml(input.mcpServers));
      env.CODEX_HOME = home;
    };
    const args = [
      "exec",
      ...(input.resumeSessionId ? ["resume", input.resumeSessionId] : []),
      "--json",
      ...modelFlag("--model", input.model, this.defaultModel),
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-", // read the prompt from stdin
    ];
    return guardedRun(
      setup,
      () =>
        runAgentProcess({
          bin: input.bin ?? this.bin,
          args,
          cwd: input.cwd,
          // Codex has no append-system-prompt flag — fold the guidance into the prompt.
          prompt: withGuidance(input.prompt, input.systemPrompt),
          env,
          signal: input.signal,
          adapter: new CodexStreamAdapter(),
          label: this.label,
          installHint: this.installHint,
          promptOnStdin: true,
        }),
      this.label,
    );
  },
};

const CURSOR: CodingAgentDefinition = {
  id: "cursor",
  label: "Cursor Agent",
  bin: "cursor-agent",
  installHint: "Install it from cursor.com/cli and run `cursor-agent login`.",
  models: [
    { value: "auto", label: "Auto" },
    { value: "claude-sonnet-4.6", label: "Sonnet 4.6" },
    { value: "claude-opus-4.6", label: "Opus 4.6" },
    { value: "gpt-5", label: "GPT-5" },
  ],
  defaultModel: "auto",
  streaming: true,
  supportsResume: true,
  run(input) {
    const setup = () => {
      // Cursor reads MCP servers from <cwd>/.cursor/mcp.json (project scope).
      if (hasServers(input.mcpServers)) {
        writeJson(path.join(input.cwd, ".cursor", "mcp.json"), { mcpServers: input.mcpServers });
      }
    };
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--force", // allow tool use without prompts
      ...(hasServers(input.mcpServers) ? ["--approve-mcps"] : []),
      ...modelFlag("--model", input.model, this.defaultModel),
      ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
      // Prompt is positional and last; cursor-agent's print mode doesn't read stdin.
      withGuidance(input.prompt, input.systemPrompt),
    ];
    return guardedRun(
      setup,
      () =>
        runAgentProcess({
          bin: input.bin ?? this.bin,
          args,
          cwd: input.cwd,
          prompt: "",
          signal: input.signal,
          // Cursor's stream-json mirrors Claude Code's envelope (system/assistant/user/result).
          adapter: new ClaudeStreamAdapter(),
          label: this.label,
          installHint: this.installHint,
          promptOnStdin: false,
        }),
      this.label,
    );
  },
};

const GEMINI: CodingAgentDefinition = {
  id: "gemini",
  label: "Gemini CLI",
  bin: "gemini",
  installHint:
    "Install it with `npm i -g @google/gemini-cli` and authenticate (GEMINI_API_KEY or `gemini`).",
  models: [
    { value: "auto", label: "Auto" },
    { value: "gemini-2.5-pro", label: "2.5 Pro" },
    { value: "gemini-2.5-flash", label: "2.5 Flash" },
  ],
  defaultModel: "auto",
  streaming: true,
  supportsResume: false,
  run(input) {
    const setup = () => {
      // Gemini reads MCP servers from <cwd>/.gemini/settings.json (project scope).
      if (hasServers(input.mcpServers)) {
        writeJson(path.join(input.cwd, ".gemini", "settings.json"), {
          mcpServers: input.mcpServers,
        });
      }
    };
    const args = [
      "--output-format",
      "stream-json",
      "--approval-mode",
      "yolo", // auto-approve tool use (no TTY to confirm)
      ...modelFlag("--model", input.model, this.defaultModel),
      "-p",
      withGuidance(input.prompt, input.systemPrompt),
    ];
    return guardedRun(
      setup,
      () =>
        runAgentProcess({
          bin: input.bin ?? this.bin,
          args,
          cwd: input.cwd,
          prompt: "",
          signal: input.signal,
          adapter: new GeminiStreamAdapter(),
          label: this.label,
          installHint: this.installHint,
          promptOnStdin: false,
        }),
      this.label,
    );
  },
};

const COPILOT: CodingAgentDefinition = {
  id: "copilot",
  label: "GitHub Copilot",
  bin: "copilot",
  installHint:
    "Install it with `npm i -g @github/copilot` and authenticate (GH_TOKEN or `copilot`).",
  models: [
    { value: "auto", label: "Auto" },
    { value: "claude-sonnet-4.6", label: "Sonnet 4.6" },
    { value: "gpt-5", label: "GPT-5" },
  ],
  defaultModel: "auto",
  // Copilot's `-p` mode emits plain text, not a structured stream — no live trace.
  streaming: false,
  supportsResume: false,
  run(input) {
    const mcpFile = path.join(input.cwd, ".copilot", "mcp-config.json");
    const setup = () => {
      if (hasServers(input.mcpServers)) {
        // Copilot's headless mode only loads MCP via --additional-mcp-config (its
        // type:"local" shape). Per-invocation file, injected by flag below.
        const servers = Object.fromEntries(
          Object.entries(input.mcpServers).map(([name, s]) => [
            name,
            { type: "local", command: s.command, args: s.args, env: s.env ?? {}, tools: "*" },
          ]),
        );
        writeJson(mcpFile, { mcpServers: servers });
      }
    };
    const args = [
      "-p",
      withGuidance(input.prompt, input.systemPrompt),
      "--allow-all-tools",
      "--silent", // drop session chrome so stdout is just the answer
      ...modelFlag("--model", input.model, this.defaultModel),
      ...(hasServers(input.mcpServers) ? ["--additional-mcp-config", mcpFile] : []),
    ];
    return guardedRun(
      setup,
      () =>
        runAgentProcess({
          bin: input.bin ?? this.bin,
          args,
          cwd: input.cwd,
          prompt: "",
          signal: input.signal,
          adapter: new PlainTextStreamAdapter(),
          label: this.label,
          installHint: this.installHint,
          promptOnStdin: false,
          expectsResult: false, // plain text → no result line; the adapter flushes one
        }),
      this.label,
    );
  },
};

/** Render a Codex `config.toml` `[mcp_servers.*]` block for the injected meOS servers. */
function codexConfigToml(servers: Record<string, McpServerSpec>): string {
  const lines: string[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${JSON.stringify(spec.command)}`);
    lines.push(`args = ${JSON.stringify(spec.args)}`);
    if (spec.env && Object.keys(spec.env).length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [k, v] of Object.entries(spec.env)) lines.push(`${k} = ${JSON.stringify(v)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Every agent meOS knows how to drive, in display order. */
export const CODING_AGENTS: readonly CodingAgentDefinition[] = [
  CLAUDE,
  CODEX,
  CURSOR,
  GEMINI,
  COPILOT,
];

/** Look up an agent definition by id (defaults to Claude — the original behaviour). */
export function getCodingAgent(id?: string): CodingAgentDefinition {
  return CODING_AGENTS.find((a) => a.id === id) ?? CLAUDE;
}
