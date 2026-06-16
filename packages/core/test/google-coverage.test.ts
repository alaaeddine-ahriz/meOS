import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCalendarDelta, fetchCalendarList } from "../src/connectors/google/calendar.js";
import { fetchGmailDelta } from "../src/connectors/google/gmail.js";
import type { ConnectorKindConfig } from "../src/connectors/types.js";

/**
 * Drives the Google REST clients against a scripted `fetch` so we can assert the
 * resumable-backfill cursor, the history-cursor-expiry fallback, and per-calendar
 * multi-calendar selection without a network or real tokens (#68).
 */

type Handler = (url: string) => unknown | { __status: number };

function mockFetch(routes: Array<{ match: RegExp; reply: Handler }>): void {
  vi.stubGlobal("fetch", async (input: string) => {
    const url = String(input);
    for (const route of routes) {
      if (route.match.test(url)) {
        const body = route.reply(url);
        const status =
          body && typeof body === "object" && "__status" in (body as object)
            ? (body as { __status: number }).__status
            : 200;
        const json = status === 200 ? body : {};
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => json,
          text: async () => JSON.stringify(json),
        } as Response;
      }
    }
    throw new Error(`unmatched fetch: ${url}`);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Gmail resumable backfill (#68)", () => {
  it("seeds recent, then walks backfill pages and persists a resumable cursor", async () => {
    const seen = new Set<string>();
    mockFetch([
      // Recent seed (no q param) — most recent messages.
      {
        match: /\/messages\?maxResults=100$/,
        reply: () => ({ messages: [{ id: "recent1" }] }),
      },
      { match: /\/profile/, reply: () => ({ historyId: "h100" }) },
      // Backfill listing (has q=after:). First call returns a page token.
      {
        match: /\/messages\?maxResults=100&q=after/,
        reply: (url) => {
          if (url.includes("pageToken=")) return { messages: [{ id: "old2" }] }; // last page, no token
          return { messages: [{ id: "old1" }], nextPageToken: "PT1" };
        },
      },
      // Per-message metadata fetch.
      {
        match: /\/messages\/[^?]+\?format=metadata/,
        reply: (url) => {
          const id = url.split("/messages/")[1]!.split("?")[0]!;
          seen.add(id);
          return {
            id,
            threadId: `t-${id}`,
            internalDate: String(Date.parse("2024-01-01T00:00:00Z")),
            snippet: "snip",
            payload: { headers: [{ name: "Subject", value: `S-${id}` }] },
          };
        },
      },
    ]);

    const config: ConnectorKindConfig = { coverageWindow: "1y", contentMode: "metadata" };
    const delta = await fetchGmailDelta("tok", null, config);

    // Recent seed cursor recorded.
    expect(delta.nextSyncToken).toBe("h100");
    // Backfill state advanced and (since the page budget is 3 and only 2 pages
    // exist) it ran to completion in one call.
    expect(delta.nextConfig?.backfill?.indexed).toBeGreaterThan(0);
    expect(delta.nextConfig?.backfill?.complete).toBe(true);
    expect(delta.nextConfig?.coverageWindow).toBe("1y");
    // Recent + backfilled messages all surfaced.
    expect(delta.items.map((i) => i.externalId).sort()).toEqual(["old1", "old2", "recent1"]);
  });

  it("does NOT backfill in the default 'recent' window", async () => {
    mockFetch([
      { match: /\/messages\?maxResults=100$/, reply: () => ({ messages: [{ id: "r1" }] }) },
      { match: /\/profile/, reply: () => ({ historyId: "h1" }) },
      {
        match: /\/messages\/[^?]+\?format=metadata/,
        reply: (url) => ({ id: url.split("/messages/")[1]!.split("?")[0], threadId: "t" }),
      },
    ]);
    const delta = await fetchGmailDelta("tok", null, { coverageWindow: "recent" });
    expect(delta.nextConfig?.backfill?.complete).toBe(true);
    expect(delta.hasMore).toBe(false);
    expect(delta.items).toHaveLength(1);
  });

  it("falls back to a recent re-list (not a destructive resync) when the history cursor expired", async () => {
    let historyCalls = 0;
    mockFetch([
      // history.list returns 404 (expired startHistoryId) — must not shrink coverage.
      {
        match: /\/history\?/,
        reply: () => {
          historyCalls++;
          return { __status: 404 };
        },
      },
      { match: /\/messages\?maxResults=100$/, reply: () => ({ messages: [{ id: "fresh1" }] }) },
      { match: /\/profile/, reply: () => ({ historyId: "h-new" }) },
      {
        match: /\/messages\/[^?]+\?format=metadata/,
        reply: (url) => ({ id: url.split("/messages/")[1]!.split("?")[0], threadId: "t" }),
      },
    ]);

    const delta = await fetchGmailDelta("tok", "stale-history-id", { coverageWindow: "recent" });
    expect(historyCalls).toBe(1);
    // Coverage preserved: re-seeded from the recent list with a fresh cursor — no
    // fullResync flag (which would clear everything).
    expect(delta.fullResync).toBeFalsy();
    expect(delta.nextSyncToken).toBe("h-new");
    expect(delta.items.map((i) => i.externalId)).toEqual(["fresh1"]);
  });

  it("indexes the body only in the explicit 'rich' content mode", async () => {
    const b64 = Buffer.from("Hello body").toString("base64");
    mockFetch([
      { match: /\/messages\?maxResults=100$/, reply: () => ({ messages: [{ id: "m1" }] }) },
      { match: /\/profile/, reply: () => ({ historyId: "h" }) },
      {
        match: /\/messages\/[^?]+\?format=full/,
        reply: () => ({
          id: "m1",
          threadId: "t",
          payload: { mimeType: "text/plain", body: { data: b64 }, headers: [] },
        }),
      },
    ]);
    const delta = await fetchGmailDelta("tok", null, { contentMode: "rich" });
    expect(delta.items[0]!.body).toBe("Hello body");
  });
});

describe("Calendar multi-calendar sync (#68)", () => {
  it("syncs every enabled calendar with its own sync token", async () => {
    mockFetch([
      {
        match: /\/calendars\/primary\/events/,
        reply: () => ({
          items: [
            { id: "p1", summary: "Primary event", start: { dateTime: "2026-01-01T00:00:00Z" } },
          ],
          nextSyncToken: "primary-token",
        }),
      },
      {
        match: /\/calendars\/team%40example.com\/events/,
        reply: () => ({
          items: [
            { id: "t1", summary: "Team event", start: { dateTime: "2026-02-01T00:00:00Z" } },
            { id: "t2", status: "cancelled" },
          ],
          nextSyncToken: "team-token",
        }),
      },
    ]);

    const config: ConnectorKindConfig = {
      coverageWindow: "1y",
      enabledCalendars: ["primary", "team@example.com"],
    };
    const delta = await fetchCalendarDelta("tok", null, config);

    expect(delta.items.map((i) => i.externalId).sort()).toEqual(["p1", "t1"]);
    expect(delta.deletions).toEqual(["t2"]);
    // Each calendar kept its own token + progress.
    const cals = delta.nextConfig?.calendars ?? {};
    expect(cals.primary?.syncToken).toBe("primary-token");
    expect(cals["team@example.com"]?.syncToken).toBe("team-token");
    expect(cals["team@example.com"]?.indexed).toBe(1);
  });

  it("re-pulls only the stale calendar from the window, leaving others intact", async () => {
    let primaryCalls = 0;
    mockFetch([
      {
        match: /\/calendars\/primary\/events/,
        reply: (url) => {
          primaryCalls++;
          // First call (with syncToken) is stale → 410; the bounded re-pull (timeMin) succeeds.
          if (url.includes("syncToken=")) return { __status: 410 };
          return { items: [{ id: "p1", summary: "Recovered" }], nextSyncToken: "fresh-primary" };
        },
      },
      {
        match: /\/calendars\/other\/events/,
        reply: () => ({ items: [{ id: "o1", summary: "Other" }], nextSyncToken: "other-token" }),
      },
    ]);

    const config: ConnectorKindConfig = {
      coverageWindow: "all",
      enabledCalendars: ["primary", "other"],
      calendars: {
        primary: { syncToken: "stale", lastSyncedAt: null, indexed: 0 },
        other: { syncToken: null, lastSyncedAt: null, indexed: 0 },
      },
    };
    const delta = await fetchCalendarDelta("tok", null, config);

    // Two primary calls: the stale token, then the bounded re-pull.
    expect(primaryCalls).toBe(2);
    expect(delta.items.map((i) => i.externalId).sort()).toEqual(["o1", "p1"]);
    expect(delta.nextConfig?.calendars?.primary?.syncToken).toBe("fresh-primary");
    expect(delta.nextConfig?.calendars?.other?.syncToken).toBe("other-token");
  });

  it("lists calendars primary-first for the picker", async () => {
    mockFetch([
      {
        match: /\/users\/me\/calendarList/,
        reply: () => ({
          items: [
            { id: "z@example.com", summary: "Zeta" },
            { id: "primary", summary: "Me", primary: true, accessRole: "owner" },
            { id: "a@example.com", summary: "Alpha" },
          ],
        }),
      },
    ]);
    const list = await fetchCalendarList("tok");
    expect(list[0]!.primary).toBe(true);
    expect(list.map((c) => c.summary)).toEqual(["Me", "Alpha", "Zeta"]);
  });
});
