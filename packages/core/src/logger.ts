import { pino, type Logger } from "pino";

/**
 * The single structured logger shared by every Node-side MeOS package. Core
 * stages and the server log through one Pino instance, so their output
 * interleaves in one stream and one format; child loggers tag each line with the
 * emitting `module` (replacing the hand-written `[prefix]` strings that used to
 * front raw `console.*` calls), making the source obvious without grepping.
 *
 * Configuration is environment-driven and zero-touch:
 * - **Level** comes from `LOG_LEVEL` (default `info`). Set `LOG_LEVEL=debug` for
 *   detail, `LOG_LEVEL=silent` to mute.
 * - **Format**: on an interactive TTY (local `pnpm dev`) output is prettified via
 *   `pino-pretty` for readability; otherwise — piped, containerized, packaged
 *   desktop, or production — it stays newline-delimited JSON that log shippers
 *   and the desktop shell can parse. Keying off the TTY (not `NODE_ENV`) means a
 *   bundled app with no `NODE_ENV` set still gets machine-readable logs.
 * - **Tests** run silent by default (detected via `VITEST`/`NODE_ENV=test`) so
 *   suites stay quiet; override with `LOG_LEVEL` when debugging a test.
 */

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;
const usePretty = !isTest && process.stdout.isTTY === true;

function resolveLevel(): string {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  return isTest ? "silent" : "info";
}

/** The root logger. Prefer {@link createLogger} so every line carries a module tag. */
export const logger: Logger = pino({
  level: resolveLevel(),
  ...(usePretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
});

/**
 * A child logger tagged with the module that emits it, e.g.
 * `createLogger("scheduler").info("nightly consolidation")`. Pass structured
 * fields as the first argument and a message second — `log.error({ err }, "…")`
 * — so Pino serializes the error (with stack) instead of stringifying it.
 */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}
