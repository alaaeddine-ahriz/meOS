import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Resolve the monorepo root (two levels up from packages/core/test/).
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const configPath = join(repoRoot, ".dependency-cruiser.cjs");

/**
 * Run dependency-cruiser over a single specifier-bearing file and return the
 * JSON cruise result. We point depcruise at a throwaway file inside the real
 * packages/<pkg>/src tree so the `from` path rules match, then assert on the
 * detected violations. The throwaway file is always removed afterwards.
 */
function cruiseSnippet(relSourceFile: string, contents: string) {
  const absSource = join(repoRoot, relSourceFile);
  writeFileSync(absSource, contents);
  try {
    const out = execFileSync(
      "npx",
      ["depcruise", relSourceFile, "--config", configPath, "--output-type", "json"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(out) as {
      summary: { violations: { rule: { name: string }; from: string; to: string }[] };
    };
  } finally {
    rmSync(absSource, { force: true });
  }
}

function ruleNames(result: ReturnType<typeof cruiseSnippet>) {
  return result.summary.violations.map((v) => v.rule.name);
}

// Each case spawns `npx depcruise` (a cold dependency-cruiser run over the whole
// graph), which routinely takes 5-6s and can exceed vitest's 5s default under
// full-suite parallel load. Give the suite headroom so it is not flaky.
describe("package boundaries (dependency-cruiser)", { timeout: 60_000 }, () => {
  it("flags core depending on server as an error", () => {
    const result = cruiseSnippet("packages/core/src/__arch_probe__.ts", 'import "@meos/server";\n');
    expect(ruleNames(result)).toContain("core-stays-agnostic");
  });

  it("flags web importing @meos/core (web must be HTTP-only)", () => {
    const result = cruiseSnippet("packages/web/src/__arch_probe__.ts", 'import "@meos/core";\n');
    expect(ruleNames(result)).toContain("web-is-http-only");
  });

  it("flags server importing the web frontend", () => {
    const result = cruiseSnippet("packages/server/src/__arch_probe__.ts", 'import "@meos/web";\n');
    expect(ruleNames(result)).toContain("server-no-frontend");
  });

  it("flags a deep import across a @meos package boundary", () => {
    const result = cruiseSnippet(
      "packages/server/src/__arch_probe__.ts",
      'import "@meos/core/src/config.js";\n',
    );
    expect(ruleNames(result)).toContain("no-deep-cross-package");
  });
});
