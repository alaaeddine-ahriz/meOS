import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { ClaudeStreamAdapter } from "./adapter.js";
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  type ClaudeAgentEvent,
  type ClaudeRunOptions,
} from "./types.js";

/**
 * Run Claude Code headlessly and yield its run as a normalized event stream.
 *
 * Spawns `claude -p --output-format stream-json --verbose …`, feeds the prompt
 * on stdin (robust to prompts that start with `-`), reads stdout NDJSON
 * line-by-line through {@link ClaudeStreamAdapter}, and yields events in order.
 * The child is killed on `signal` abort (client disconnect) or when the consumer
 * stops iterating. A terminal `error` event is yielded if the CLI is missing,
 * fails to spawn, or exits without emitting a `result`.
 */
export async function* runClaudeCodeAgent(opts: ClaudeRunOptions): AsyncIterable<ClaudeAgentEvent> {
  const bin = opts.bin ?? "claude";
  const args = [
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
    ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
  ];

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Make the child its own process-group leader (POSIX) so that on abort we
      // can signal the whole group — the agent's Bash tool spawns subprocesses
      // (builds, servers) that would otherwise be orphaned when we kill the CLI.
      detached: process.platform !== "win32",
    });
  } catch (error) {
    yield { type: "error", message: spawnErrorMessage(error, bin) };
    return;
  }

  // Print mode reads the prompt from stdin when none is passed positionally.
  child.stdin.on("error", () => {}); // swallow EPIPE if the child died early
  child.stdin.end(opts.prompt);

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 8192) stderr += chunk;
  });

  let spawnError: Error | null = null;
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.on("error", (error) => {
    spawnError = error;
    rl.close(); // ENOENT etc.: stdout never flows, so end the line loop ourselves
  });

  const abort = () => killChild(child);
  if (opts.signal) {
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
  }

  const adapter = new ClaudeStreamAdapter();
  let sawResult = false;
  try {
    for await (const line of rl) {
      for (const event of adapter.push(line)) {
        if (event.type === "result") sawResult = true;
        yield event;
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", abort);
    killChild(child); // consumer stopped early → don't leak the process
  }

  const code = await exitCode(child);
  if (spawnError) {
    yield { type: "error", message: spawnErrorMessage(spawnError, bin) };
  } else if (!sawResult && !opts.signal?.aborted) {
    const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
    yield {
      type: "error",
      message: tail
        ? `Claude Code exited (code ${code ?? "?"}): ${tail}`
        : `Claude Code exited without a result (code ${code ?? "?"}).`,
    };
  }
}

function killChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalGroup(child, "SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup(child, "SIGKILL");
  }, 2000).unref();
}

/**
 * Signal the child's whole process group (it leads its own group, since it was
 * spawned `detached`), so any subprocess its Bash tool started dies too. Falls
 * back to signalling just the child on Windows / if the group is already gone.
 */
function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal); // negative pid → the process group
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return; // already gone
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already dead
  }
}

function exitCode(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("close", (code) => resolve(code)));
}

function spawnErrorMessage(error: unknown, bin: string): string {
  if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT") {
    return `Claude Code CLI not found (\`${bin}\`). Install it with \`npm i -g @anthropic-ai/claude-code\` and make sure it's on PATH.`;
  }
  return `Failed to start Claude Code: ${error instanceof Error ? error.message : String(error)}`;
}
