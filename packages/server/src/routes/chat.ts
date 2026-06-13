import type { FastifyInstance } from "fastify";
import { buildContextPack, ChatService } from "@meos/core";
import type { AppContext } from "../context.js";

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  const chat = new ChatService(ctx.store, ctx.llm, ctx.embedder, ctx.events);

  app.post("/api/conversations", async (_request, reply) => {
    return reply.code(201).send({ id: ctx.store.createConversation() });
  });

  app.get("/api/conversations", async () => ({
    conversations: ctx.store.listConversations(),
  }));

  app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (request, reply) => {
    const id = Number(request.params.id);
    if (!ctx.store.conversationExists(id)) {
      return reply.code(404).send({ error: "No such conversation" });
    }
    return { messages: ctx.store.listMessages(id) };
  });

  app.post<{ Body: { conversationId?: number; message: string } }>("/api/chat", async (request, reply) => {
    const { message } = request.body ?? {};
    if (!message?.trim()) {
      return reply.code(400).send({ error: "Field 'message' is required" });
    }
    let conversationId = request.body.conversationId;
    if (conversationId === undefined) {
      conversationId = ctx.store.createConversation();
    } else if (!ctx.store.conversationExists(conversationId)) {
      return reply.code(404).send({ error: "No such conversation" });
    }

    // Writing to the raw socket bypasses Fastify, which would otherwise both
    // drop the CORS headers @fastify/cors put on the reply (the desktop shell
    // is cross-origin — WebKit then fails the fetch with "Load failed") and
    // try to send a second response when the handler returns.
    reply.hijack();
    const headers: Record<string, string | number | string[]> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    };
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined && !(name in headers)) headers[name] = value;
    }
    reply.raw.writeHead(200, headers);
    const send = (event: object) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

    send({ type: "start", conversationId });
    try {
      for await (const event of chat.respond(conversationId, message)) {
        send(event);
      }
      send({ type: "done" });
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    reply.raw.end();
  });

  app.get<{ Querystring: { q?: string } }>("/api/search", async (request, reply) => {
    const query = request.query.q?.trim();
    if (!query) {
      return reply.code(400).send({ error: "Query parameter 'q' is required" });
    }
    const context = await buildContextPack(ctx.store, ctx.embedder, query);
    return {
      entities: context.matchedEntities.map((e) => ({ name: e.name, slug: e.slug, type: e.type })),
      sources: context.sources,
    };
  });
}
