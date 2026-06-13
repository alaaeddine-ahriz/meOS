import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type { AppContext } from "./context.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerDigestRoutes } from "./routes/digest.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerOutputRoutes } from "./routes/outputs.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerWikiRoutes } from "./routes/wiki.js";

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: "info" } });
  // The Tauri desktop shell serves the UI from tauri:// (or its dev server),
  // so its API calls are cross-origin; browsers reach us same-origin instead.
  await app.register(cors, {
    origin: [
      "tauri://localhost",
      "http://tauri.localhost",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
  });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });

  app.get("/api/health", async () => ({ ok: true, llmProvider: ctx.config.llm.provider }));

  registerIngestRoutes(app, ctx);
  registerWikiRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerDigestRoutes(app, ctx);
  registerOutputRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerGitRoutes(app, ctx);

  // In production the built web app is served from this same process; in dev
  // the Vite server proxies /api here instead and this block is skipped.
  const webDist = path.resolve(fileURLToPath(import.meta.url), "../../../web/dist");
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
