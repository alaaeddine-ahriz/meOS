import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLogger } from "@meos/core";

const log = createLogger("worker-host");

/**
 * Process isolation (#94). The app process serves the UI and only enqueues work;
 * a forked **worker host** runs the heavy background workers (ingest executor,
 * scheduler/consolidation, connector sync, wiki regen) against the same SQLite.
 * Because `better-sqlite3` is synchronous, keeping heavy DB transactions and CPU
 * passes out of the app process keeps the HTTP loop — and the UI — responsive,
 * and a worker crash can no longer take the API down.
 *
 * Coordination is almost entirely through the DB (durable jobs + the
 * cross-process safety from the multi-process-safe claim/staging work). These
 * IPC messages are a latency optimization + the bridge for the few app-originated
 * triggers that must run in the single writer process (chat crystallization,
 * connector sync): the worker's own sweep is the backstop if a message is lost.
 */
export type WorkerMessage =
  | { type: "pump" }
  | { type: "event"; name: "onSessionEnd"; payload: { conversationId: number } }
  | {
      type: "connector";
      action: "enqueueSync" | "reschedule" | "syncAllEnabled";
      args?: { provider?: string; kind?: string };
    }
  | { type: "consolidate" }
  | { type: "shutdown" };

/** What the app process uses to drive the worker host (implemented by the supervisor). */
export interface WorkerBridge {
  /** Wake the executor to claim freshly-enqueued/retried jobs. */
  notifyPump(): void;
  /** Forward an app-emitted event to the worker's event bus. */
  forwardEvent(name: "onSessionEnd", payload: { conversationId: number }): void;
  /** Forward a connector action to the worker (sync execution lives there). */
  forwardConnector(
    action: "enqueueSync" | "reschedule" | "syncAllEnabled",
    args?: { provider?: string; kind?: string },
  ): void;
  /** Forward a consolidation run to the worker (it merges into the graph). */
  forwardConsolidate(): void;
}

/** How often the worker host writes each worker's health to the DB. */
export const HEARTBEAT_MS = 5_000;
/** A worker whose heartbeat is older than this is treated as down by the reader. */
export const HEARTBEAT_STALE_MS = 20_000;
/** Cap on buffered messages while the child is (re)starting, so a flapping worker can't leak memory. */
const MAX_BUFFERED = 1_000;

/**
 * Decide whether this (non-worker) process should split heavy work into a forked
 * worker host ("app" role) or run everything itself ("all", today's behavior).
 *
 * Opt-in and conservative: the split is ON only when `MEOS_WORKER_PROCESS=1` is
 * set explicitly. `MEOS_IN_PROCESS_WORKERS=1` is a hard override that always
 * forces single-process — the kill switch.
 */
export function resolveSplitRole(env = process.env): "app" | "all" {
  if (env["MEOS_IN_PROCESS_WORKERS"] === "1") return "all";
  return env["MEOS_WORKER_PROCESS"] === "1" ? "app" : "all";
}

/**
 * Forks the worker host and keeps it alive, restarting it with a delay if it
 * exits unexpectedly. Implements {@link WorkerBridge}: messages sent before the
 * child is connected (startup, mid-restart) are buffered and flushed on spawn.
 * Crash isolation: the worker dying never affects this (the app) process — the
 * supervisor just respawns it, and the durable layer's stale-lease recovery
 * reclaims any job the dead worker had in flight.
 */
export class WorkerSupervisor implements WorkerBridge {
  private child: ChildProcess | undefined;
  private buffer: WorkerMessage[] = [];
  private stopped = false;

  constructor(
    private readonly opts: {
      /** The worker-host entry (`import.meta.url`-resolved by the caller). */
      entryUrl: string;
      /** Running from TypeScript source (dev/tsx) → fork the child under tsx too. */
      isTs: boolean;
      /** Delay before respawning a crashed worker. */
      restartDelayMs?: number;
    },
  ) {}

  start(): void {
    this.spawn();
  }

  private spawn(): void {
    if (this.stopped) return;
    const execArgv = this.opts.isTs ? ["--import", "tsx"] : [];
    const child = fork(fileURLToPath(this.opts.entryUrl), [], {
      execArgv,
      // The child inherits cwd + MEOS_* (data dir, model cache) automatically.
      // MEOS_ROLE routes it to the worker entry; MEOS_EXIT_WITH_PARENT makes it
      // die with us even on SIGKILL (it watches its ppid, see worker-host).
      env: { ...process.env, MEOS_ROLE: "worker", MEOS_EXIT_WITH_PARENT: "1" },
    });
    this.child = child;
    log.info({ pid: child.pid }, "worker host spawned");

    child.on("spawn", () => {
      const pending = this.buffer.splice(0);
      for (const msg of pending) child.send(msg);
    });
    child.on("error", (err) => log.error({ err }, "worker host error"));
    child.on("exit", (code, signal) => {
      this.child = undefined;
      if (this.stopped) return;
      log.warn({ code, signal }, "worker host exited; restarting");
      setTimeout(() => this.spawn(), this.opts.restartDelayMs ?? 1_000).unref();
    });
  }

  private send(msg: WorkerMessage): void {
    if (this.stopped) return;
    if (this.child?.connected) {
      this.child.send(msg);
    } else if (this.buffer.length < MAX_BUFFERED) {
      this.buffer.push(msg);
    }
    // Over the cap we drop: a lost `pump` is recovered by the worker's sweep, and
    // the buffer only fills while the worker is restarting.
  }

  notifyPump(): void {
    this.send({ type: "pump" });
  }

  forwardEvent(name: "onSessionEnd", payload: { conversationId: number }): void {
    this.send({ type: "event", name, payload });
  }

  forwardConnector(
    action: "enqueueSync" | "reschedule" | "syncAllEnabled",
    args?: { provider?: string; kind?: string },
  ): void {
    this.send({ type: "connector", action, args });
  }

  forwardConsolidate(): void {
    this.send({ type: "consolidate" });
  }

  /** Ask the worker to shut down gracefully, then stop respawning it. */
  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    child.send?.({ type: "shutdown" } satisfies WorkerMessage);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3_000);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
