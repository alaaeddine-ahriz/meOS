import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function registerIngestRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/ingest/upload", async (request, reply) => {
    const accepted: Array<{ inboxItemId: number; filename: string }> = [];
    for await (const part of request.files()) {
      const buffer = await part.toBuffer();
      const filename = part.filename;
      const inboxItemId = ctx.store.createInboxItem(filename);
      ctx.queue.push(() =>
        ctx.pipeline
          .ingest({ kind: "file", filename, buffer, origin: "upload" }, inboxItemId)
          .then(() => undefined),
      );
      accepted.push({ inboxItemId, filename });
    }
    if (accepted.length === 0) {
      return reply.code(400).send({ error: "No files in request" });
    }
    return reply.code(202).send({ accepted });
  });

  app.post<{ Body: { title?: string; text: string } }>("/api/ingest/text", async (request, reply) => {
    const { title, text } = request.body ?? {};
    if (!text?.trim()) {
      return reply.code(400).send({ error: "Field 'text' is required" });
    }
    const resolvedTitle = title?.trim() || `Note ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const inboxItemId = ctx.store.createInboxItem(resolvedTitle);
    ctx.queue.push(() =>
      ctx.pipeline
        .ingest({ kind: "text", title: resolvedTitle, text, origin: "quick-capture" }, inboxItemId)
        .then(() => undefined),
    );
    return reply.code(202).send({ inboxItemId });
  });

  app.get("/api/inbox", async () => ({
    queuePending: ctx.queue.pending,
    items: ctx.store.listInbox(),
  }));
}
