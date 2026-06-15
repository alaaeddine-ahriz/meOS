import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../src/context.js";
import { createContext } from "../../src/context.js";
import { buildServer } from "../../src/server.js";

/**
 * A built Fastify app wired against a throwaway SQLite DB and a stubbed LLM,
 * plus the underlying context and a `cleanup` that closes the app and removes
 * the temp data dir. Tests drive `app` with `app.inject(...)` — no socket bind,
 * no network, no secrets.
 */
export interface TestServer {
  app: FastifyInstance;
  ctx: AppContext;
  /** The temp root that holds `meos.config.json` + the data dir. */
  rootDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Build the real server the same way production does — through `createContext`
 * + `buildServer` — but pointed at an `fs.mkdtemp` root. We write a minimal
 * `meos.config.json` there that selects the deterministic `hash` embedder (no
 * native ONNX worker) and forces the `local` LLM provider, whose AI-SDK client
 * is constructed lazily and keyless — so the app boots with no network and no
 * secrets. (`local` rather than the test-only `stub` provider keeps the
 * /api/settings/llm response valid against the public contract, which doesn't
 * expose `stub`.) None of the covered endpoints actually invoke the model, so
 * nothing reaches the wire. `MEOS_DATA_DIR` (absolute) sends the SQLite file +
 * wiki/vault dirs into the same temp tree. Everything is removed by `cleanup`.
 */
export async function buildTestServer(): Promise<TestServer> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-server-test-"));
  const dataDir = path.join(rootDir, "data");

  // The hash embedder is deterministic and loads no native ONNX worker, so the
  // app stays offline and fast. createContext reads this via loadConfig(rootDir).
  fs.writeFileSync(
    path.join(rootDir, "meos.config.json"),
    JSON.stringify({
      dataDir,
      embedding: { provider: "hash", model: "hash" },
      llm: { provider: "local", local: { baseUrl: "http://localhost:1234/v1", model: "test" } },
    }),
  );

  const prevProvider = process.env.MEOS_LLM_PROVIDER;
  const prevDataDir = process.env.MEOS_DATA_DIR;
  // MEOS_WEB_DIST must NOT point at a real dist, or buildServer registers the
  // static handler + SPA fallback and unknown /api routes 404 as index.html.
  const prevWebDist = process.env.MEOS_WEB_DIST;
  // Ensure no stray env provider overrides our config-selected `local` provider.
  delete process.env.MEOS_LLM_PROVIDER;
  process.env.MEOS_DATA_DIR = dataDir;
  process.env.MEOS_WEB_DIST = path.join(rootDir, "no-web-dist");

  const ctx = createContext(rootDir);
  const app = await buildServer(ctx);
  await app.ready();

  const restoreEnv = () => {
    if (prevProvider === undefined) delete process.env.MEOS_LLM_PROVIDER;
    else process.env.MEOS_LLM_PROVIDER = prevProvider;
    if (prevDataDir === undefined) delete process.env.MEOS_DATA_DIR;
    else process.env.MEOS_DATA_DIR = prevDataDir;
    if (prevWebDist === undefined) delete process.env.MEOS_WEB_DIST;
    else process.env.MEOS_WEB_DIST = prevWebDist;
  };

  const cleanup = async () => {
    try {
      await app.close();
    } finally {
      restoreEnv();
      try {
        ctx.db.close();
      } catch {
        // already closed by app teardown / never opened
      }
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  };

  return { app, ctx, rootDir, cleanup };
}
