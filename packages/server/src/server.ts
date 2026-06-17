import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { logger } from "@meos/core";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type { AppContext } from "./context.js";
import { registerErrorHandler } from "./errors.js";
import { registerOpenApi } from "./openapi.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerCalendarRoutes } from "./routes/calendar.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerConnectorRoutes } from "./routes/connectors.js";
import { registerDigestRoutes } from "./routes/digest.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerMeetingRoutes } from "./routes/meetings.js";
import { registerOutputRoutes } from "./routes/outputs.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerRuntimeRoutes } from "./routes/runtime.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerVaultRoutes } from "./routes/vault.js";
import { registerWikiRoutes } from "./routes/wiki.js";

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  // Share the one MeOS Pino instance so HTTP request logs (with per-request
  // reqId) and the app's own logs interleave in a single stream and format;
  // level/pretty-vs-JSON are governed centrally by @meos/core's logger.
  // The cast widens Pino's concrete `Logger` to Fastify's `FastifyBaseLogger`:
  // without it Fastify pins its logger generic to Pino's type and the
  // default-typed FastifyInstance return (and every route registration below) no
  // longer matches. ESLint sees only the argument→parameter fit (where Pino's
  // Logger is accepted) and misreads the cast as redundant; it steers generic
  // inference, which the rule can't account for.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const app = Fastify({ loggerInstance: logger as FastifyBaseLogger });
  // The Tauri desktop shell serves the UI from tauri:// (or its dev server),
  // so its API calls are cross-origin; browsers reach us same-origin instead.
  await app.register(cors, {
    origin: [
      "tauri://localhost",
      "http://tauri.localhost",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
    // Without this the preflight only advertises GET/HEAD/POST, so the desktop
    // shell's cross-origin PUT/DELETE calls (save settings, remove a folder)
    // are blocked by the webview and surface as a "Load failed" fetch error.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });

  // Every thrown error — typed ApiError, validation failures, uncaught — is
  // turned into the single error envelope, tagged with request.id.
  registerErrorHandler(app);

  // OpenAPI spec + docs, generated from the route schemas. Registered before the
  // routes so each can attach its own JSON schema for richer documentation.
  await registerOpenApi(app);

  // Keep `ok` + `llmProvider` intact (the CI web-smoke depends on `ok`); add a
  // compact `workers` status list so a basic health check sees the runtime too.
  app.get("/api/health", async () => ({
    ok: true,
    llmProvider: ctx.config.llm.provider,
    workers: ctx.workers.health().map((w) => ({ name: w.name, status: w.status })),
  }));

  // The machine-readable spec; @fastify/swagger has assembled it by the time the
  // server is ready (it builds lazily from registered routes + components).
  app.get("/api/openapi.json", async () => app.swagger());

  registerIngestRoutes(app, ctx);
  registerMeetingRoutes(app, ctx);
  registerWikiRoutes(app, ctx);
  registerVaultRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerActivityRoutes(app, ctx);
  registerDigestRoutes(app, ctx);
  registerOutputRoutes(app, ctx);
  registerProfileRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerConnectorRoutes(app, ctx);
  registerCalendarRoutes(app, ctx);
  registerGitRoutes(app, ctx);
  registerRuntimeRoutes(app, ctx);

  // In production the built web app is served from this same process; in dev
  // the Vite server proxies /api here instead and this block is skipped. The
  // desktop bundle relocates the UI, so MEOS_WEB_DIST overrides the default
  // (which assumes the repo's packages/server/dist ↔ packages/web/dist layout).
  const webDist =
    process.env.MEOS_WEB_DIST ?? path.resolve(fileURLToPath(import.meta.url), "../../../web/dist");
  const serveStatic = fs.existsSync(webDist);
  if (serveStatic) {
    await app.register(fastifyStatic, { root: webDist });
  }

  // Unknown routes must honor the API contract. Any `/api/*` miss returns the
  // shared error envelope (NOT_FOUND) regardless of whether the static web app
  // is mounted — so the error model is identical in dev, test, and production.
  // Non-API misses fall back to the SPA's index.html when it's available.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({
        code: "NOT_FOUND",
        message: "Not found",
        requestId: request.id,
        recoverable: false,
      });
    }
    if (serveStatic) return reply.sendFile("index.html");
    return reply.code(404).send({
      code: "NOT_FOUND",
      message: "Not found",
      requestId: request.id,
      recoverable: false,
    });
  });

  return app;
}
