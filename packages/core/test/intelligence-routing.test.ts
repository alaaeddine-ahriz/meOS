import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { AiSdkClient } from "../src/llm/ai-sdk.js";
import { CodingAgentLlmClient } from "../src/llm/coding-agent-client.js";
import {
  defaultIntelligenceRouting,
  resolveGroupClient,
  withRoutingDefaults,
  type IntelligenceRouting,
} from "../src/llm/intelligence-routing.js";

/** A config whose `createLlmClient` builds a real (keyless) AiSdkClient — the `local` provider. */
function localConfig() {
  const config = structuredClone(defaultConfig);
  config.llm.provider = "local";
  config.llm.local = { baseUrl: "http://127.0.0.1:1234", model: "test-model" };
  return config;
}

describe("withRoutingDefaults", () => {
  it("defaults to the api backend on an empty stored value", () => {
    expect(withRoutingDefaults(undefined)).toEqual({ backend: "api" });
    expect(withRoutingDefaults(null)).toEqual({ backend: "api" });
  });

  it("preserves an agent backend with its pinned agentId + model", () => {
    const routing = withRoutingDefaults({ backend: "agent", agentId: "codex", model: "gpt-5" });
    expect(routing).toEqual({ backend: "agent", agentId: "codex", model: "gpt-5" });
  });

  it("coerces the legacy per-group shape to the api backend", () => {
    // The old shape ({ background, wiki, assistant }) predates the single-backend
    // model — it has no `backend`, so it must drop to the safe api default.
    const legacy = {
      background: { source: "agent", agentId: "claude" },
      wiki: { source: "auto" },
      assistant: { source: "api" },
    } as unknown as Partial<IntelligenceRouting>;
    expect(withRoutingDefaults(legacy)).toEqual({ backend: "api" });
  });

  it("coerces junk / a bad backend to the api default", () => {
    expect(withRoutingDefaults({ backend: "weird" as never })).toEqual({ backend: "api" });
    expect(withRoutingDefaults({ agentId: "codex" })).toEqual({ backend: "api" });
  });
});

describe("resolveGroupClient", () => {
  const config = localConfig();

  it('backend "api" → the cloud AiSdkClient (for every group)', () => {
    const routing = defaultIntelligenceRouting(); // { backend: "api" }
    for (const group of ["background", "wiki", "assistant"] as const) {
      const client = resolveGroupClient(group, config, routing, new Set(["claude"]));
      expect(client).toBeInstanceOf(AiSdkClient);
      expect(client).not.toBeInstanceOf(CodingAgentLlmClient);
    }
  });

  it('backend "agent" → a CodingAgentLlmClient when the agent IS installed', () => {
    const routing: IntelligenceRouting = { backend: "agent", agentId: "claude" };
    for (const group of ["background", "wiki", "assistant"] as const) {
      const client = resolveGroupClient(group, config, routing, new Set(["claude"]));
      expect(client).toBeInstanceOf(CodingAgentLlmClient);
    }
  });

  it('backend "agent" defaults the agent id to claude', () => {
    const routing: IntelligenceRouting = { backend: "agent" };
    expect(resolveGroupClient("wiki", config, routing, new Set(["claude"]))).toBeInstanceOf(
      CodingAgentLlmClient,
    );
  });

  it('backend "agent" but the agent is NOT installed → falls back to the cloud client', () => {
    // The guard: a misconfigured/uninstalled agent must never brick the app.
    const routing: IntelligenceRouting = { backend: "agent", agentId: "codex" };
    const client = resolveGroupClient("assistant", config, routing, new Set(["claude"]));
    expect(client).toBeInstanceOf(AiSdkClient);
    expect(client).not.toBeInstanceOf(CodingAgentLlmClient);

    // Nothing installed at all → also the cloud client.
    expect(resolveGroupClient("assistant", config, routing, new Set())).toBeInstanceOf(AiSdkClient);
  });
});
