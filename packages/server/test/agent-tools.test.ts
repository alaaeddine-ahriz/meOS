import { ErrorCode, ErrorEnvelopeSchema } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

/**
 * The agent-mode connector-tools bridge: the endpoints the `meos-connectors` MCP
 * server proxies so the local coding agent reaches the user's connected services
 * through meOS — reusing the already-authorized OAuth, never a second auth flow.
 */
describe("GET /api/agent/connector-tools (none connected)", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await buildTestServer();
  });
  afterAll(async () => {
    await server.cleanup();
  });

  it("returns an empty toolset when no connector is connected", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/agent/connector-tools" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tools: [], hints: [] });
  });
});

describe("connector agent tools (Google connected)", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await buildTestServer();
    // Seed a connected Google account whose access token is already expired and
    // carries NO refresh token: the tools are still assembled (a token exists),
    // but resolving a live one fails WITHOUT any network — so invoking a tool
    // exercises the real server-side path deterministically and offline.
    const accountId = server.ctx.store.upsertConnectorAccount({
      provider: "google",
      accountEmail: "user@example.com",
      accessToken: "expired-access-token",
      expiry: new Date(Date.now() - 3_600_000).toISOString(),
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    for (const kind of ["calendar", "tasks", "contacts", "gmail"]) {
      server.ctx.store.setSyncState(accountId, kind, { enabled: true });
    }
  });
  afterAll(async () => {
    await server.cleanup();
  });

  it("advertises one tool per enabled kind, with JSON-Schema inputs intact", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/agent/connector-tools" });
    expect(res.statusCode).toBe(200);
    const { tools, hints } = res.json() as {
      tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
      hints: string[];
    };

    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_task",
      "fetch_email_threads",
      "list_tasks",
      "lookup_contact",
      "search_calendar",
    ]);
    expect(hints.some((h) => h.includes("Google tools"))).toBe(true);

    // The arbitrary JSON-Schema blob must survive Fastify serialization untouched
    // (a strict response schema would silently strip it) — assert the real shape.
    const calendar = tools.find((t) => t.name === "search_calendar")!;
    expect(calendar.description.length).toBeGreaterThan(0);
    expect(calendar.inputSchema).toMatchObject({ type: "object" });
    const props = (calendar.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(["query", "timeMax", "timeMin"]);
  });

  it("runs a tool server-side and surfaces an auth problem as a tool result", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/agent/connector-tools/search_calendar",
      payload: { query: "standup" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { result: string; isError: boolean };
    // The connector catches the unusable-account error and returns an explanatory
    // string (no throw, no network), telling the agent to have the user reconnect
    // in meOS — exactly what we want instead of the agent starting its own OAuth.
    expect(body.result).toMatch(/re-authentication/i);
  });

  it("returns a 404 envelope for an unknown tool", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/agent/connector-tools/not_a_real_tool",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.NOT_FOUND);
  });
});
