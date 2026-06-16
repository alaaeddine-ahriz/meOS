import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

/**
 * Calendar events for `@`-mention autocomplete. A read-only projection of the
 * synced `google:calendar` sources (see `KnowledgeStore.listCalendarEvents`),
 * used by the note editor to reference an event and prefill a meeting's date +
 * attendees. Returns an empty list when Calendar isn't connected.
 */
export function registerCalendarRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/api/calendar/events",
    async (request) => {
      const q = request.query.q ?? "";
      const limit = Math.min(Math.max(Number(request.query.limit) || 8, 1), 25);
      return { events: ctx.store.listCalendarEvents(q, limit) };
    },
  );
}
