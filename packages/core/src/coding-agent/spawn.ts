import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent, StreamAdapter } from "./types.js";

/**
 * Provider-agnostic process plumbing for a coding-agent run. Spawns an external
 * CLI, feeds the prompt, reads its stdout line-by-line through a {@link
 * StreamAdapter} that maps the CLI's own format onto the normalized {@link
 * AgentEvent} stream, and yields events in order. The child is killed on `signal`
 * abort (client disconnect) or when the consumer stops iterating.
 *
 * This was extracted verbatim from the original Claude-only runner so that every
 * agent (Claude Code, Codex, Cursor, Gemini, Copilot…) shares the exact same
 * spawn/abort/line-reading behaviour and only differs in its argv + adapter.
 */
export interface AgentProcessOptions {
  /** Binary to spawn (resolved on PATH). */
  bin: string;
  /** Argument vector (everything except the prompt, unless the prompt is positional). */
  args: string[];
  /** Working directory the agent reads and edits files in. */
  cwd: string;
  /** The user's instruction for this turn. Written to stdin when `promptOnStdin`. */
  prompt: string;
  /** Extra environment overlaid on the inherited process env. */
  env?: NodeJS.ProcessEnv;
  /** Abort the run (kills the child) — wired to client disconnect. */
  signal?: AbortSignal;
  /** Maps this CLI's stdout lines onto the normalized event stream. */
  adapter: StreamAdapter;
  /** Human name for error messages ("Claude Code", "Codex"…). */
  label: string;
  /** Shown when the binary is missing (ENOENT) — how to install it. */
  installHint: string;
  /**
   * When true, the prompt is written to the child's stdin (robust to prompts that
   * start with `-`). When false, the prompt is already baked into `args`
   * positionally and stdin is closed immediately.
   */
  promptOnStdin: boolean;
  /**
   * When true (the default), a run that ends without emitting a terminal `result`
   * event is reported as an error. Text-only agents (no structured result line)
   * set this false and rely on their adapter's `flush()` to close the run.
   */
  expectsResult?: boolean;
}

export async function* runAgentProcess(opts: AgentProcessOptions): AsyncIterable<AgentEvent> {
  const { bin, args, adapter, label, installHint } = opts;
  const expectsResult = opts.expectsResult ?? true;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Make the child its own process-group leader (POSIX) so that on abort we
      // can signal the whole group — the agent's shell tools spawn subprocesses
      // (builds, servers) that would otherwise be orphaned when we kill the CLI.
      detached: process.platform !== "win32",
      // Keep the packaged desktop app windowless: don't pop a console for the CLI.
      windowsHide: true,
    });
  } catch (error) {
    yield { type: "error", message: spawnErrorMessage(error, bin, label, installHint) };
    return;
  }

  child.stdin.on("error", () => {}); // swallow EPIPE if the child died early
  // Print/headless mode reads the prompt from stdin when none is passed
  // positionally; otherwise just close stdin so a non-TTY child doesn't block.
  child.stdin.end(opts.promptOnStdin ? opts.prompt : "");

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

  let sawResult = false;
  const emit = function* (events: AgentEvent[]): Iterable<AgentEvent> {
    for (const event of events) {
      if (event.type === "result") sawResult = true;
      yield event;
    }
  };
  try {
    for await (const line of rl) yield* emit(adapter.push(line));
    // Flush any buffered terminal state (text-only adapters synthesize their
    // `result` here, since their CLI has no result line to key off of).
    yield* emit(adapter.flush?.() ?? []);
  } finally {
    opts.signal?.removeEventListener("abort", abort);
    killChild(child); // consumer stopped early → don't leak the process
  }

  const code = await exitCode(child);
  if (spawnError) {
    yield { type: "error", message: spawnErrorMessage(spawnError, bin, label, installHint) };
  } else if (expectsResult && !sawResult && !opts.signal?.aborted) {
    const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
    yield {
      type: "error",
      message: tail
        ? `${label} exited (code ${code ?? "?"}): ${tail}`
        : `${label} exited without a result (code ${code ?? "?"}).`,
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
 * spawned `detached`), so any subprocess its shell tool started dies too. Falls
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

function spawnErrorMessage(error: unknown, bin: string, label: string, hint: string): string {
  if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT") {
    return `${label} CLI not found (\`${bin}\`). ${hint}`;
  }
  return `Failed to start ${label}: ${error instanceof Error ? error.message : String(error)}`;
}
