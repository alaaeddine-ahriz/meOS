import path from "node:path";
import type { ToolSet } from "ai";

/**
 * Execution + filesystem limits for a single agentic wiki regeneration. Defaults
 * are deliberately generous so legitimate multi-section, multi-page edits always
 * succeed; they exist to stop a runaway or abusive run, not to throttle normal
 * work. Exceeding any limit aborts the run and the writer falls back to the
 * deterministic {@link synthesizeBody} body — an oversized/abusive change is
 * never committed.
 */
export interface WikiSandboxLimits {
  /** Wall-clock budget for the whole agent run, in milliseconds. */
  runTimeoutMs: number;
  /** Max bytes a single write/command may emit (content or stdout). */
  maxOutputBytes: number;
  /** Max number of distinct files the run may create or mutate. */
  maxFilesTouched: number;
  /** Max bytes the resulting page body may differ from the prior body. */
  maxPageDiffBytes: number;
}

/** Generous defaults — see {@link WikiSandboxLimits}. */
export const DEFAULT_WIKI_SANDBOX_LIMITS: WikiSandboxLimits = {
  // A wiki page run is short prose editing; 2 min is ample even on a slow model.
  runTimeoutMs: 120_000,
  // ~256 KB per write — far larger than any real page, but caps a flood.
  maxOutputBytes: 256 * 1024,
  // A run edits its own page + SUMMARY.txt and may scratch a few temp files.
  maxFilesTouched: 32,
  // A single page rarely changes by more than a few KB; 128 KB is very generous.
  maxPageDiffBytes: 128 * 1024,
};

/** Why the guard rejected an operation — surfaced in audit logs. */
export type GuardViolation =
  | { kind: "path-escape"; path: string; reason: string }
  | { kind: "limit"; limit: keyof WikiSandboxLimits; value: number; max: number };

/** Raised when the run breaches a configured execution limit; aborts the run. */
export class WikiLimitExceededError extends Error {
  constructor(readonly violation: Extract<GuardViolation, { kind: "limit" }>) {
    super(`wiki run limit exceeded: ${violation.limit} (${violation.value} > ${violation.max})`);
    this.name = "WikiLimitExceededError";
  }
}

/** Raised when an agent-produced path escapes the workspace; aborts the op. */
export class WikiPathEscapeError extends Error {
  constructor(readonly violation: Extract<GuardViolation, { kind: "path-escape" }>) {
    super(`wiki path escapes workspace: ${violation.path} (${violation.reason})`);
    this.name = "WikiPathEscapeError";
  }
}

/** A single audited tool event the writer persists to the audit trail. */
export interface GuardAuditEvent {
  tool: string;
  /** The file path the operation targeted, when applicable. */
  targetPath?: string;
  success: boolean;
  /** Present when the op was rejected. */
  violation?: GuardViolation;
}

/**
 * Reject any path that escapes the sandbox wiki workspace. The wiki agent only
 * ever legitimately touches files *relative to* the workspace root (its own page
 * under `<type>/<slug>.md`, sibling pages, and `SUMMARY.txt`). This validates the
 * agent-supplied path string before it reaches the sandbox, independent of the
 * sandbox's internal mount representation:
 *
 *  - absolute paths (`/etc/passwd`, `C:\…`, UNC) are rejected — the agent must
 *    stay relative to the workspace;
 *  - `..` traversal segments are rejected — no climbing out of the workspace;
 *  - null bytes / control chars are rejected — no path-smuggling tricks.
 *
 * A path passing this check, resolved against the workspace root, is guaranteed
 * to stay within it. (The sandbox itself is an in-memory copy-on-write overlay,
 * so even a bypass cannot reach raw watched files, the DB, or credentials — this
 * is the explicit defence-in-depth layer the writer applies on top.)
 */
export function checkWorkspacePath(
  rawPath: string,
): Extract<GuardViolation, { kind: "path-escape" }> | null {
  const reason = (r: string) => ({ kind: "path-escape" as const, path: rawPath, reason: r });
  if (typeof rawPath !== "string" || rawPath.length === 0) return reason("empty path");
  // Reject control characters (incl. NUL) used to smuggle or truncate paths.
  for (let i = 0; i < rawPath.length; i++) {
    if (rawPath.charCodeAt(i) < 0x20) return reason("control characters in path");
  }
  // Absolute (posix or windows-drive or UNC) — the agent must stay relative.
  if (
    path.posix.isAbsolute(rawPath) ||
    /^[a-zA-Z]:[\\/]/.test(rawPath) ||
    rawPath.startsWith("\\\\")
  ) {
    return reason("absolute path");
  }
  // Normalise with posix semantics and forbid any climb above the root. A
  // normalised path that still starts with ".." escaped the workspace.
  const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../")) return reason("path traversal (..)");
  // Belt-and-suspenders: reject any raw ".." segment too (catches odd inputs).
  if (rawPath.split(/[\\/]/).includes("..")) return reason("path traversal (..)");
  return null;
}

/** Throwing form of {@link checkWorkspacePath}. */
export function assertInWorkspace(rawPath: string): void {
  const violation = checkWorkspacePath(rawPath);
  if (violation) throw new WikiPathEscapeError(violation);
}

/**
 * Tracks per-run execution limits across every guarded tool call. The writer
 * starts one tracker per regeneration and routes the wrapped tools through it;
 * the first breach throws {@link WikiLimitExceededError} so the run aborts and
 * the writer can fall back safely.
 */
export class RunLimitTracker {
  private readonly touched = new Set<string>();
  private readonly startedAt = Date.now();

  constructor(private readonly limits: WikiSandboxLimits) {}

  /** Throw if the wall-clock budget has elapsed (checked at each tool call). */
  assertWithinTime(): void {
    const elapsed = Date.now() - this.startedAt;
    if (elapsed > this.limits.runTimeoutMs) {
      throw new WikiLimitExceededError({
        kind: "limit",
        limit: "runTimeoutMs",
        value: elapsed,
        max: this.limits.runTimeoutMs,
      });
    }
  }

  /** Throw if a single output (write content / stdout) exceeds the byte cap. */
  assertOutputSize(bytes: number): void {
    if (bytes > this.limits.maxOutputBytes) {
      throw new WikiLimitExceededError({
        kind: "limit",
        limit: "maxOutputBytes",
        value: bytes,
        max: this.limits.maxOutputBytes,
      });
    }
  }

  /** Record a file mutation; throw once the distinct-files cap is exceeded. */
  noteFileTouched(filePath: string): void {
    this.touched.add(path.posix.normalize(filePath.replaceAll("\\", "/")));
    if (this.touched.size > this.limits.maxFilesTouched) {
      throw new WikiLimitExceededError({
        kind: "limit",
        limit: "maxFilesTouched",
        value: this.touched.size,
        max: this.limits.maxFilesTouched,
      });
    }
  }

  /** Validate the final page diff against the cap (checked at write-back). */
  checkPageDiff(
    beforeBody: string | null,
    afterBody: string,
  ): Extract<GuardViolation, { kind: "limit" }> | null {
    const diff = Math.abs(
      Buffer.byteLength(afterBody, "utf-8") - Buffer.byteLength(beforeBody ?? "", "utf-8"),
    );
    if (diff > this.limits.maxPageDiffBytes) {
      return {
        kind: "limit",
        limit: "maxPageDiffBytes",
        value: diff,
        max: this.limits.maxPageDiffBytes,
      };
    }
    return null;
  }
}

const asRecord = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" ? (input as Record<string, unknown>) : {};

const stringField = (input: unknown, key: string): string | undefined => {
  const value = asRecord(input)[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * Wrap a bash-tool toolkit's tools so every agent file mutation and command is
 * validated against the workspace allowlist and the run's execution limits, and
 * reported via `onAudit` (tool name, target path, success/failure, violation)
 * before it can touch the sandbox. `writeFile` is the primary mutation seam;
 * `bash` command size is capped. Reads (`readFile`) are still validated for path
 * escape but never counted against the file-mutation budget.
 *
 * A rejected write/command throws so the underlying agent run aborts; the writer
 * catches it, audits it, and falls back to the deterministic synthesised body.
 */
export function guardTools(
  tools: ToolSet,
  tracker: RunLimitTracker,
  onAudit: (event: GuardAuditEvent) => void,
): ToolSet {
  const guarded: ToolSet = { ...tools };

  const wrap = (
    name: string,
    pathOf: (input: unknown) => string | undefined,
    outputBytesOf: (input: unknown) => number | undefined,
    countsAsMutation: boolean,
  ) => {
    const original = tools[name];
    if (!original?.execute) return;
    const inner = original.execute.bind(original);
    guarded[name] = {
      ...original,
      execute: async (
        input: unknown,
        options: Parameters<NonNullable<typeof original.execute>>[1],
      ) => {
        const targetPath = pathOf(input);
        try {
          tracker.assertWithinTime();
          if (targetPath !== undefined) {
            const violation = checkWorkspacePath(targetPath);
            if (violation) {
              onAudit({ tool: name, targetPath, success: false, violation });
              throw new WikiPathEscapeError(violation);
            }
          }
          const bytes = outputBytesOf(input);
          if (bytes !== undefined) tracker.assertOutputSize(bytes);
          if (countsAsMutation && targetPath !== undefined) tracker.noteFileTouched(targetPath);
          const result = await inner(input, options);
          onAudit({ tool: name, targetPath, success: true });
          return result;
        } catch (error) {
          if (error instanceof WikiLimitExceededError) {
            onAudit({ tool: name, targetPath, success: false, violation: error.violation });
          } else if (!(error instanceof WikiPathEscapeError)) {
            // Path-escape was already audited above; audit any other failure.
            onAudit({ tool: name, targetPath, success: false });
          }
          throw error;
        }
      },
    } as ToolSet[string];
  };

  wrap(
    "writeFile",
    (input) => stringField(input, "path"),
    (input) => {
      const content = stringField(input, "content");
      return content === undefined ? undefined : Buffer.byteLength(content, "utf-8");
    },
    true,
  );
  wrap(
    "readFile",
    (input) => stringField(input, "path"),
    () => undefined,
    false,
  );
  // bash: no single path to allowlist (commands are arbitrary), but cap the
  // command's declared size and time it; its stdout is already capped by
  // bash-tool's maxOutputLength.
  wrap(
    "bash",
    () => undefined,
    (input) => {
      const command = stringField(input, "command");
      return command === undefined ? undefined : Buffer.byteLength(command, "utf-8");
    },
    false,
  );

  return guarded;
}
