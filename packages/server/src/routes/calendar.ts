import { calendar } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { routeSchema } from "../route-schema.js";

const tags = ["calendar"];

/**
 * Calendar events for `@`-mention autocomplete. A read-only projection of the
 * synced `google:calendar` sources (see `KnowledgeStore.listCalendarEvents`),
 * used by the note editor to reference an event and prefill a meeting's date +
 * attendees. Returns an empty list when Calendar isn't connected.
 */
export function registerCalendarRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/api/calendar/events",
    {
      schema: routeSchema({
        tags,
        summary: "List calendar events",
        response: calendar.ListCalendarEventsResponse,
      }),
    },
    async (request) => {
      const q = request.query.q ?? "";
      const limit = Math.min(Math.max(Number(request.query.limit) || 8, 1), 25);
      return calendar.ListCalendarEventsResponse.parse({
        events: ctx.store.listCalendarEvents(q, limit),
      });
    },
  );
}
