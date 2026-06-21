import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CODING_AGENTS } from "./registry.js";
import type { CodingAgentDefinition, CodingAgentSummary } from "./types.js";

/**
 * Resolve a bare command name against the current PATH, returning its absolute
 * path or null — the same lookup a shell does. First gate for "is this agent
 * available": its binary has to exist.
 *
 * On Windows we also try the PATHEXT suffixes (.cmd/.exe/.bat), since npm-shipped
 * CLIs install as `claude.cmd` etc. there.
 */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // An explicit path (rare) — trust it if it's an executable file.
  if (bin.includes(path.sep) || bin.includes("/")) {
    return isExecutableFile(bin) ? bin : null;
  }
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const suffixes =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((s) => s.toLowerCase())]
      : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, bin + suffix);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true; // no x-bit concept; PATHEXT gates it
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Identity-probe results, cached briefly so listing agents on every chat open
// doesn't shell out repeatedly — but still picks up a freshly-installed CLI.
const VERIFY_TTL_MS = 60_000;
const verifyCache = new Map<string, { ok: boolean; at: number }>();

/**
 * Confirm a binary on PATH is actually the agent we think it is — not an
 * unrelated program that merely shares the name (e.g. a `codex` blog-generator
 * script shadowing OpenAI's `codex`). Every real agent CLI prints a version
 * NUMBER for `--version`; an impostor prints an error or nothing. So we run
 * `<bin> --version` and require a version-like token, with same-name help/error
 * phrases rejected. Cheap, cached, and timeout-bounded.
 */
function verifyIdentity(binPath: string, versionArgs: readonly string[]): boolean {
  const cached = verifyCache.get(binPath);
  const now = Date.now();
  if (cached && now - cached.at < VERIFY_TTL_MS) return cached.ok;
  let ok = false;
  try {
    const res = spawnSync(binPath, versionArgs, {
      timeout: 4000,
      encoding: "utf8",
      windowsHide: true,
    });
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    ok =
      !res.error &&
      /\d+\.\d+/.test(out) && // a real version string (1.0.61, 2025.11.06, 0.45.0…)
      !/not supported|unknown option|unrecognized|usage:/i.test(out);
  } catch {
    ok = false;
  }
  verifyCache.set(binPath, { ok, at: now });
  return ok;
}

/** True iff the agent's binary is on PATH AND verifies as the real CLI. */
export function isAgentInstalled(
  def: CodingAgentDefinition,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const binPath = findOnPath(def.bin, env);
  // Version flags to probe for identity (per-agent override via the definition).
  return binPath !== null && verifyIdentity(binPath, def.versionArgs ?? ["--version"]);
}

/**
 * Every agent meOS supports, projected to the UI-facing summary with an
 * `installed` flag. The chat picker lists them ALL — installed ones selectable,
 * the rest greyed out with an install hint — so the user can see what's supported
 * and how to get it, and can never accidentally run a same-named impostor.
 */
export function listAgents(env: NodeJS.ProcessEnv = process.env): CodingAgentSummary[] {
  return CODING_AGENTS.map((a) => ({
    id: a.id,
    label: a.label,
    models: a.models,
    defaultModel: a.defaultModel,
    streaming: a.streaming,
    installed: isAgentInstalled(a, env),
    installHint: a.installHint,
  }));
}
