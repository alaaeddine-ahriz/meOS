import { chat as chatSchema } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import {
  buildContextPack,
  ChatService,
  listAgents,
  LlmError,
  loadProfileContext,
} from "@meos/core";
import type { AppContext } from "../context.js";
import { runCodingAgent } from "../coding-agent-command.js";
import { httpError, parseOrThrow } from "../errors.js";
import { isProfileCommand, runProfileCommand } from "../profile-command.js";
import { routeSchema } from "../route-schema.js";

const tags = ["chat"];

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Re-read the profile each turn so edits apply immediately (no restart). The
  // ChatService assembles connector agent tools (e.g. Gmail thread fetch) straight
  // from the connector registry each turn, so a newly-connected service's tools
  // appear without a restart.
  const chat = new ChatService(ctx.store, ctx.llm, ctx.embedder, ctx.events, () =>
    loadProfileContext(ctx.config.dataDir),
  );

  app.post(
    "/api/conversations",
    {
      schema: routeSchema({
        tags,
        summary: "Create a conversation",
        response: { 201: chatSchema.CreateConversationResponse },
      }),
    },
    async (_request, reply) => {
      return reply
        .code(201)
        .send(chatSchema.CreateConversationResponse.parse({ id: ctx.store.createConversation() }));
    },
  );

  app.get(
    "/api/conversations",
    {
      schema: routeSchema({
        tags,
        summary: "List conversations",
        response: chatSchema.ListConversationsResponse,
      }),
    },
    async () =>
      chatSchema.ListConversationsResponse.parse({
        conversations: ctx.store.listConversations(),
      }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/messages",
    {
      schema: routeSchema({
        tags,
        summary: "List messages in a conversation",
        params: chatSchema.ConversationIdParam,
        response: chatSchema.MessagesResponse,
      }),
    },
    async (request) => {
      const { id } = parseOrThrow(chatSchema.ConversationIdParam, request.params, "params");
      if (!ctx.store.conversationExists(id)) {
        throw httpError.notFound("No such conversation");
      }
      return chatSchema.MessagesResponse.parse({ messages: ctx.store.listMessages(id) });
    },
  );

  // Close a conversation: distil it into a first-class session source in the
  // background (crystallization). Fires the onSessionEnd hook.
  app.post<{ Params: { id: string } }>(
    "/api/conversations/:id/end",
    {
      schema: routeSchema({
        tags,
        summary: "End a conversation",
        params: chatSchema.ConversationIdParam,
        response: { 202: chatSchema.EndConversationResponse },
      }),
    },
    async (request, reply) => {
      const { id } = parseOrThrow(chatSchema.ConversationIdParam, request.params, "params");
      if (!ctx.store.conversationExists(id)) {
        throw httpError.notFound("No such conversation");
      }
      await ctx.events.emit("onSessionEnd", { conversationId: id });
      return reply
        .code(202)
        .send(chatSchema.EndConversationResponse.parse({ crystallizing: true }));
    },
  );

  // Every supported coding agent + whether it's installed here — drives the
  // chat's agent picker (installed ones selectable, the rest greyed out).
  app.get(
    "/api/coding-agents",
    {
      schema: routeSchema({
        tags,
        summary: "List supported coding agents and their install status",
        response: chatSchema.CodingAgentsResponse,
      }),
    },
    async () => chatSchema.CodingAgentsResponse.parse({ agents: listAgents() }),
  );

  app.post<{
    Body: {
      conversationId?: number;
      message: string;
      agent?: boolean;
      agentId?: string;
      model?: string;
    };
  }>(
    "/api/chat",
    {
      schema: routeSchema({
        tags,
        summary: "Stream a chat response (SSE)",
        body: chatSchema.ChatBody,
      }),
    },
    async (request, reply) => {
      // Validate the body before hijacking the socket, so a bad request still gets
      // the standard JSON error envelope (the error handler can't run post-hijack).
      const body = parseOrThrow(chatSchema.ChatBody, request.body, "body");
      if (!body.message.trim()) {
        throw httpError.validation("Field 'message' is required");
      }
      const message = body.message;
      let conversationId = body.conversationId;
      if (conversationId === undefined) {
        conversationId = ctx.store.createConversation();
      } else if (!ctx.store.conversationExists(conversationId)) {
        throw httpError.notFound("No such conversation");
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

      // Agent mode: drive the user's local coding agent (Claude Code) for this
      // turn instead of the knowledge-base assistant. It can run for minutes, so
      // (a) wire an abort to client disconnect — tab close / in-app navigation /
      // the Stop button all close the socket, which kills the child — and (b)
      // keep the connection alive through long, silent tool steps with a
      // heartbeat (the client skips `: ping` comment frames).
      if (body.agent) {
        const controller = new AbortController();
        const onClose = () => controller.abort();
        // Listen on the RESPONSE socket, not request.raw: for a POST the request
        // stream emits "close" as soon as its body is consumed (immediately),
        // which would abort the run before it starts. reply.raw "close" fires
        // only when the client actually disconnects.
        reply.raw.on("close", onClose);
        const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25000);
        try {
          await runCodingAgent(
            ctx,
            conversationId,
            message,
            send,
            controller.signal,
            body.model,
            body.agentId,
          );
          send({ type: "done" });
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        } finally {
          clearInterval(heartbeat);
          reply.raw.off("close", onClose);
        }
        reply.raw.end();
        return;
      }

      // Slash commands are app directives, not questions — handle them before the
      // retrieval/answer pipeline. `/profile <instruction>` edits the profile lens.
      if (isProfileCommand(message)) {
        try {
          await runProfileCommand(ctx, conversationId, message, send);
          send({ type: "done" });
        } catch (error) {
          if (error instanceof LlmError) {
            send({ type: "error", message: error.message, kind: error.kind });
          } else {
            send({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        reply.raw.end();
        return;
      }

      try {
        for await (const event of chat.respond(conversationId, message)) {
          send(event);
        }
        send({ type: "done" });
      } catch (error) {
        // LlmError carries an already-user-facing message and a kind the client
        // uses to offer the right fix (e.g. open Settings on auth/credit errors).
        if (error instanceof LlmError) {
          send({ type: "error", message: error.message, kind: error.kind });
        } else {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }
      reply.raw.end();
    },
  );

  app.get<{ Querystring: { q?: string } }>(
    "/api/search",
    {
      schema: routeSchema({
        tags,
        summary: "Search entities and sources",
        querystring: chatSchema.SearchQuery,
        response: chatSchema.SearchResponse,
      }),
    },
    async (request) => {
      const { q } = parseOrThrow(chatSchema.SearchQuery, request.query, "query");
      const query = q.trim();
      if (!query) {
        throw httpError.validation("Query parameter 'q' is required");
      }
      const context = await buildContextPack(ctx.store, ctx.embedder, query);
      return chatSchema.SearchResponse.parse({
        entities: context.matchedEntities.map((e) => ({
          name: e.name,
          slug: e.slug,
          type: e.type,
        })),
        sources: context.sources,
      });
    },
  );
}
