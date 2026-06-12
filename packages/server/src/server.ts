import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type { AppContext } from "./context.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerDigestRoutes } from "./routes/digest.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerWikiRoutes } from "./routes/wiki.js";

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: "info" } });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });

  app.get("/api/health", async () => ({ ok: true, llmProvider: ctx.config.llm.provider }));

  registerIngestRoutes(app, ctx);
  registerWikiRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerDigestRoutes(app, ctx);

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
