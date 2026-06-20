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
  it("fills every group with auto on an empty stored value", () => {
    const routing = withRoutingDefaults(undefined);
    expect(routing.background.source).toBe("auto");
    expect(routing.wiki.source).toBe("auto");
    expect(routing.assistant.source).toBe("auto");
  });

  it("coerces an unknown source to auto and preserves known ones", () => {
    const routing = withRoutingDefaults({
      background: { source: "weird" as never },
      wiki: { source: "agent", agentId: "codex" },
      assistant: { source: "api" },
    });
    expect(routing.background.source).toBe("auto");
    expect(routing.wiki.source).toBe("agent");
    expect(routing.wiki.agentId).toBe("codex");
    expect(routing.assistant.source).toBe("api");
  });
});

describe("resolveGroupClient", () => {
  const config = localConfig();

  it('source "api" → the cloud AiSdkClient', () => {
    const routing: IntelligenceRouting = {
      ...defaultIntelligenceRouting(),
      background: { source: "api" },
    };
    const client = resolveGroupClient("background", config, routing, new Set());
    expect(client).toBeInstanceOf(AiSdkClient);
    expect(client).not.toBeInstanceOf(CodingAgentLlmClient);
  });

  it('source "agent" → a CodingAgentLlmClient (even when nothing is installed)', () => {
    const routing: IntelligenceRouting = {
      ...defaultIntelligenceRouting(),
      wiki: { source: "agent", agentId: "claude" },
    };
    const client = resolveGroupClient("wiki", config, routing, new Set());
    expect(client).toBeInstanceOf(CodingAgentLlmClient);
  });

  it('source "auto" → agent when the default agent id IS installed', () => {
    const routing = defaultIntelligenceRouting(); // every group "auto", resolves to "claude"
    const client = resolveGroupClient("assistant", config, routing, new Set(["claude"]));
    expect(client).toBeInstanceOf(CodingAgentLlmClient);
  });

  it('source "auto" → api when the default agent id is NOT installed', () => {
    const routing = defaultIntelligenceRouting();
    const client = resolveGroupClient("assistant", config, routing, new Set(["codex"]));
    expect(client).toBeInstanceOf(AiSdkClient);
    expect(client).not.toBeInstanceOf(CodingAgentLlmClient);
  });

  it('source "auto" honours a group\'s pinned agentId for the install check', () => {
    const routing: IntelligenceRouting = {
      ...defaultIntelligenceRouting(),
      background: { source: "auto", agentId: "codex" },
    };
    // claude installed but the group pins codex (not installed) → api.
    expect(resolveGroupClient("background", config, routing, new Set(["claude"]))).toBeInstanceOf(
      AiSdkClient,
    );
    // codex installed and pinned → agent.
    expect(resolveGroupClient("background", config, routing, new Set(["codex"]))).toBeInstanceOf(
      CodingAgentLlmClient,
    );
  });

  it("falls back to defaultAgent.agentId when a group pins none", () => {
    const routing: IntelligenceRouting = {
      ...defaultIntelligenceRouting(),
      defaultAgent: { agentId: "codex" },
    };
    // "auto" with codex installed (the routing-wide default) → agent.
    expect(resolveGroupClient("wiki", config, routing, new Set(["codex"]))).toBeInstanceOf(
      CodingAgentLlmClient,
    );
    // claude installed but the default is codex → api.
    expect(resolveGroupClient("wiki", config, routing, new Set(["claude"]))).toBeInstanceOf(
      AiSdkClient,
    );
  });
});
