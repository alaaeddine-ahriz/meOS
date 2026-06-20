import { ErrorCode, ErrorEnvelopeSchema } from "@meos/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAskOperation, unregisterAskOperation } from "../src/ask-registry.js";
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

/**
 * Mid-run questions: the rendezvous between the agent's blocking `ask_user` tool
 * (POST /api/agent/ask) and the user's answer (POST /api/agent/ask/answer),
 * correlated by the in-process ask-registry. Exercised end-to-end over HTTP,
 * with the run registered directly (no agent spawn).
 */
describe("mid-run questions (/api/agent/ask)", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await buildTestServer();
  });
  afterAll(async () => {
    await server.cleanup();
  });

  it("parks the ask, surfaces it on the run's stream, and resolves it on the user's answer", async () => {
    const op = "test-op-answered";
    let asked: { type: string; op: string; id: string } | null = null;
    // Stand in for the chat SSE stream: capture the ask-user frame the run would send.
    registerAskOperation(op, (event) => {
      if (event.type === "ask-user") asked = event as typeof asked;
    });

    // The MCP `ask_user` tool's blocking POST — don't await; it resolves only once answered.
    const askPromise = server.app.inject({
      method: "POST",
      url: "/api/agent/ask",
      payload: {
        op,
        questions: [
          { header: "Scope", question: "Which target?", options: [{ label: "A" }, { label: "B" }] },
        ],
      },
    });

    // Let the handler run far enough to emit the ask-user frame.
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).not.toBeNull();
    expect(asked!.op).toBe(op);

    const answerRes = await server.app.inject({
      method: "POST",
      url: "/api/agent/ask/answer",
      payload: { op, id: asked!.id, answers: [{ question: "Which target?", answers: ["B"] }] },
    });
    expect(answerRes.json()).toEqual({ ok: true });

    const askRes = await askPromise;
    expect(askRes.statusCode).toBe(200);
    expect(askRes.json()).toEqual({
      status: "answered",
      answers: [{ question: "Which target?", answers: ["B"] }],
    });
    unregisterAskOperation(op);
  });

  it("tells the agent to proceed when no live run owns the op", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/agent/ask",
      payload: {
        op: "no-such-run",
        questions: [{ header: "X", question: "Q?", options: [{ label: "A" }] }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "unavailable", answers: [] });
  });

  it("reports ok:false when answering a question that isn't open", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/agent/ask/answer",
      payload: { op: "ghost", id: "ghost", answers: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false });
  });
});
