import { defineConfig } from "vitest/config";

/**
 * Core test config (#21). `@meos/core` owns the pure-unit layer: parsing,
 * chunking, extraction schemas, merge/contradiction logic, memory rules,
 * retrieval, and the full offline ingest pipeline. Coverage is measured over all
 * of `src` with the v8 provider.
 *
 * Thresholds are pinned just BELOW the current measured coverage so the gate
 * passes today and can only be ratcheted upward — never silently regressed. Bump
 * these toward the live numbers as coverage improves; CI fails the build if any
 * metric drops below the floor here (see .github/workflows/ci.yml).
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "html", "lcov"],
      include: ["src/**"],
      thresholds: {
        statements: 70,
        branches: 58,
        functions: 73,
        lines: 72,
      },
    },
  },
});
