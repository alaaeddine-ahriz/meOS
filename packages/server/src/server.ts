import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { AppContext } from "./context.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerWikiRoutes } from "./routes/wiki.js";

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: "info" } });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });

  app.get("/api/health", async () => ({ ok: true, llmProvider: ctx.config.llm.provider }));

  registerIngestRoutes(app, ctx);
  registerWikiRoutes(app, ctx);
  registerChatRoutes(app, ctx);

  return app;
}
