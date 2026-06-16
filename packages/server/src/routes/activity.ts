import { activity } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["activity"];

export function registerActivityRoutes(app: FastifyInstance, ctx: AppContext): void {
  // The run feed (newest first) — each row becomes a card in the Activity view.
  app.get(
    "/api/activity",
    {
      schema: routeSchema({ tags, summary: "List wiki runs", response: activity.ActivityResponse }),
    },
    async () => activity.ActivityResponse.parse({ runs: ctx.store.listWikiRuns() }),
  );

  // A single run's persisted transcript, for replaying a run you didn't watch live.
  app.get<{ Params: { id: string } }>(
    "/api/activity/:id/events",
    {
      schema: routeSchema({
        tags,
        summary: "Get a run's events",
        params: activity.RunEventsParams,
        response: activity.RunEventsResponse,
      }),
    },
    async (request) => {
      const { id } = parseOrThrow(activity.RunEventsParams, request.params, "params");
      const run = ctx.store.getWikiRun(id);
      if (!run) throw httpError.notFound("No such run");
      return activity.RunEventsResponse.parse({ run, events: ctx.store.getWikiRunEvents(id) });
    },
  );

  // Live feed of all in-flight runs over SSE. Mirrors the chat route's raw-socket
  // approach (reply.hijack + manual headers) so the desktop shell's cross-origin
  // CORS headers survive and Fastify doesn't try to send a second response.
  app.get(
    "/api/activity/stream",
    { schema: { tags, summary: "Live activity stream (SSE)" } },
    async (request, reply) => {
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
      reply.raw.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`);

      const unsubscribe = ctx.activity.subscribe((event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      // Keep the connection alive through proxies, and stop publishing once it drops.
      const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25000);
      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.raw.on("close", close);
      request.raw.on("error", close);
    },
  );
}
