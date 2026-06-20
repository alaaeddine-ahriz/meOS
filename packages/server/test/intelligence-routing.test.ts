import { ErrorEnvelopeSchema, intelligence } from "@meos/contracts";
import { CodingAgentLlmClient, SwitchableLlmClient } from "@meos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTELLIGENCE_ROUTING_KEY } from "../src/context.js";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;
/**
 * Whether the `claude` CLI is installed on the machine running these tests —
 * read from the live agent picker so the install-dependent assertions branch
 * deterministically on any host (CI without a CLI, a dev box with one). The
 * not-installed guard means an `agent` backend only yields a CodingAgentLlmClient
 * when the resolved agent is actually installed.
 */
let claudeInstalled = false;

beforeAll(async () => {
  server = await buildTestServer();
  const res = await server.app.inject({ method: "GET", url: "/api/intelligence-routing" });
  const parsed = intelligence.IntelligenceRoutingResponse.parse(res.json());
  claudeInstalled = parsed.agents.some((a) => a.id === "claude" && a.installed);
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
  it("returns the default routing (api backend) + the agent picker", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/intelligence-routing" });
    expect(res.statusCode).toBe(200);
    const parsed = intelligence.IntelligenceRoutingResponse.parse(res.json());
    expect(parsed.routing.backend).toBe("api");
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
      payload: { backend: "agent", agentId: "not-a-real-agent" },
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(typeof envelope.requestId).toBe("string");
  });

  it("round-trips, persists, and re-resolves every group off the global backend", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/intelligence-routing",
      payload: { backend: "agent", agentId: "claude", model: "opus" },
    });
    expect(res.statusCode).toBe(200);
    const parsed = intelligence.IntelligenceRoutingResponse.parse(res.json());
    expect(parsed.routing).toMatchObject({ backend: "agent", agentId: "claude", model: "opus" });

    // Persisted under the settings key.
    const stored = server.ctx.store.getSetting<intelligence.IntelligenceRouting>(
      INTELLIGENCE_ROUTING_KEY,
    );
    expect(stored?.backend).toBe("agent");

    // The PUT triggered a re-resolve of EVERY group off the one global backend.
    // The not-installed guard means an agent client only when claude is installed;
    // otherwise the guard falls back to the cloud client so the app keeps working.
    for (const group of ["background", "wiki", "assistant"] as const) {
      if (claudeInstalled) {
        expect(innerOf(group)).toBeInstanceOf(CodingAgentLlmClient);
      } else {
        expect(innerOf(group)).not.toBeInstanceOf(CodingAgentLlmClient);
      }
    }
  });

  it("flips back to the api backend (hot-swap in place, every group)", async () => {
    const before = server.ctx.llmFor("background");
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/intelligence-routing",
      payload: { backend: "api" },
    });
    expect(res.statusCode).toBe(200);
    // Same SwitchableLlmClient instance (consumers keep their reference)...
    expect(server.ctx.llmFor("background")).toBe(before);
    // ...but its inner backend swapped back off the coding agent — for every group.
    for (const group of ["background", "wiki", "assistant"] as const) {
      expect(innerOf(group)).not.toBeInstanceOf(CodingAgentLlmClient);
    }
  });
});

describe("provider-health probe", () => {
  it("stays on the cloud API even when the backend is routed to an agent", async () => {
    const res = await server.app.inject({
      method: "PUT",
      url: "/api/intelligence-routing",
      payload: { backend: "agent", agentId: "claude" },
    });
    expect(res.statusCode).toBe(200);
    // The probe must test the API provider's credentials — never a local agent
    // that would always "succeed" and mask a broken key.
    expect(server.ctx.llmProbe).toBeInstanceOf(SwitchableLlmClient);
    expect(server.ctx.llmProbe.unwrap()).not.toBeInstanceOf(CodingAgentLlmClient);
  });
});
