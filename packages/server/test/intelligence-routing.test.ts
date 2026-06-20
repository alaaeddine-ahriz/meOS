import { ErrorEnvelopeSchema, intelligence } from "@meos/contracts";
import { CodingAgentLlmClient, SwitchableLlmClient } from "@meos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTELLIGENCE_ROUTING_KEY } from "../src/context.js";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

beforeAll(async () => {
  server = await buildTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

/** Read a group's current inner backend (the SwitchableLlmClient delegate). */
function innerOf(group: "background" | "wiki" | "assistant") {
  const client = server.ctx.llmFor(group);
  expect(client).toBeInstanceOf(SwitchableLlmClient);
  return client.unwrap();
}

describe("GET /api/intelligence-routing", () => {
  it("returns the default routing (auto for every group) + the agent picker", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/intelligence-routing" });
    expect(res.statusCode).toBe(200);
    const parsed = intelligence.IntelligenceRoutingResponse.parse(res.json());
    expect(parsed.routing.background.source).toBe("auto");
    expect(parsed.routing.wiki.source).toBe("auto");
    expect(parsed.routing.assistant.source).toBe("auto");
    // The picker lists every supported agent so the UI can render install state.
    expect(parsed.agents.length).toBeGreaterThan(0);
    expect(parsed.agents.some((a) => a.id === "claude")).toBe(true);
  });
});

describe("PUT /api/intelligence-routing", () => {
  it("rejects an unknown pinned agent id with the VALIDATION/BAD_REQUEST envelope", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/intelligence-routing",
      payload: {
        background: { source: "agent", agentId: "not-a-real-agent" },
        wiki: { source: "auto" },
        assistant: { source: "auto" },
      },
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(typeof envelope.requestId).toBe("string");
  });

  it("round-trips, persists, and re-resolves the changed group to an agent", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/intelligence-routing",
      payload: {
        background: { source: "agent", agentId: "claude", model: "opus" },
        wiki: { source: "api" },
        assistant: { source: "auto" },
      },
    });
    expect(res.statusCode).toBe(200);
    const parsed = intelligence.IntelligenceRoutingResponse.parse(res.json());
    expect(parsed.routing.background).toMatchObject({
      source: "agent",
      agentId: "claude",
      model: "opus",
    });
    expect(parsed.routing.wiki.source).toBe("api");

    // Persisted under the settings key.
    const stored = server.ctx.store.getSetting<intelligence.IntelligenceRouting>(
      INTELLIGENCE_ROUTING_KEY,
    );
    expect(stored?.background.source).toBe("agent");

    // The PUT triggered a re-resolve: a "source: agent" group is now backed by a
    // CodingAgentLlmClient regardless of what's installed (agent is explicit).
    expect(innerOf("background")).toBeInstanceOf(CodingAgentLlmClient);
    // An "api" group is NOT an agent client.
    expect(innerOf("wiki")).not.toBeInstanceOf(CodingAgentLlmClient);
  });

  it("a subsequent PUT flips a group back off the agent (hot-swap in place)", async () => {
    const before = server.ctx.llmFor("background");
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/intelligence-routing",
      payload: {
        background: { source: "api" },
        wiki: { source: "auto" },
        assistant: { source: "auto" },
      },
    });
    expect(res.statusCode).toBe(200);
    // Same SwitchableLlmClient instance (consumers keep their reference)...
    expect(server.ctx.llmFor("background")).toBe(before);
    // ...but its inner backend swapped back off the coding agent.
    expect(innerOf("background")).not.toBeInstanceOf(CodingAgentLlmClient);
  });
});

describe("provider-health probe", () => {
  it("stays on the cloud API even when every group is routed to an agent", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/intelligence-routing",
      payload: {
        background: { source: "agent", agentId: "claude" },
        wiki: { source: "agent", agentId: "claude" },
        assistant: { source: "agent", agentId: "claude" },
      },
    });
    expect(res.statusCode).toBe(200);
    // The probe must test the API provider's credentials — never a local agent
    // that would always "succeed" and mask a broken key.
    expect(server.ctx.llmProbe).toBeInstanceOf(SwitchableLlmClient);
    expect(server.ctx.llmProbe.unwrap()).not.toBeInstanceOf(CodingAgentLlmClient);
  });
});
