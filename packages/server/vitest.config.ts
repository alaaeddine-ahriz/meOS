import { defineConfig } from "vitest/config";

/**
 * Server test config (#21). `@meos/server` owns the integration/route layer:
 * the Fastify routes driven via `app.inject` against a throwaway SQLite DB and a
 * stubbed LLM/embedder (see test/helpers/test-server.ts), plus the e2e smoke that
 * walks the core journeys over HTTP.
 *
 * Coverage `include` is scoped to the surfaces the integration suite is
 * responsible for — the routes that have tests, the request/error plumbing
 * (server.ts, errors.ts), the durable-ingest orchestrator, and the runtime — so
 * the gate measures the tested API rather than being diluted by background
 * modules (main.ts, watcher.ts, scheduler.ts, git.ts) that the fast PR suite
 * deliberately does not boot. As untested routes gain tests, widen this include
 * and ratchet the thresholds up.
 *
 * Thresholds are pinned just BELOW the current measured coverage so the gate
 * passes today and can only ratchet upward. CI fails the build if any metric
 * drops below the floor here.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "html", "lcov"],
      include: [
        "src/routes/chat.ts",
        "src/routes/connectors.ts",
        "src/routes/ingest.ts",
        "src/routes/runtime.ts",
        "src/routes/settings.ts",
        "src/routes/wiki.ts",
        "src/runtime/**",
        "src/server.ts",
        "src/errors.ts",
        "src/durable-ingest.ts",
      ],
      thresholds: {
        statements: 47,
        branches: 33,
        functions: 54,
        lines: 47,
      },
    },
  },
});
