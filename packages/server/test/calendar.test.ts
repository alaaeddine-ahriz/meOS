import { calendar } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("GET /api/calendar/events", () => {
  it("returns an empty list when Calendar isn't connected", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/calendar/events" });
    expect(res.statusCode).toBe(200);
    const body = calendar.ListCalendarEventsResponse.parse(res.json());
    expect(body.events).toEqual([]);
  });

  it("projects synced calendar sources, parsing the event payload", async () => {
    // Materialize a calendar event the way the connector does: a `google:calendar`
    // source whose raw_content is the normalized CalendarEventItem JSON.
    server.ctx.store.createSource({
      type: "google:calendar",
      title: "Roadmap review",
      path: "https://calendar.google.com/event?eid=abc",
      content: "Roadmap review on 2026-06-20",
      rawContent: JSON.stringify({
        externalId: "evt-1",
        title: "Roadmap review",
        start: "2026-06-20T15:00:00Z",
        attendees: [{ name: "Dana Lee", email: "dana@example.com" }, { email: "sam@example.com" }],
        htmlLink: "https://calendar.google.com/event?eid=abc",
      }),
    });
    server.ctx.store.createSource({
      type: "google:calendar",
      title: "Standup",
      content: "Standup",
      rawContent: "not valid json",
    });

    const res = await server.app.inject({ method: "GET", url: "/api/calendar/events?q=roadmap" });
    expect(res.statusCode).toBe(200);
    const body = calendar.ListCalendarEventsResponse.parse(res.json());
    expect(body.events).toHaveLength(1);
    const event = body.events[0]!;
    expect(event.title).toBe("Roadmap review");
    expect(event.start).toBe("2026-06-20T15:00:00Z");
    expect(event.attendees).toEqual(["Dana Lee", "sam@example.com"]);
    expect(event.htmlLink).toBe("https://calendar.google.com/event?eid=abc");

    // A malformed payload degrades to title + link, never throws.
    const all = calendar.ListCalendarEventsResponse.parse(
      (await server.app.inject({ method: "GET", url: "/api/calendar/events" })).json(),
    );
    expect(all.events.some((e) => e.title === "Standup")).toBe(true);
  });
});
