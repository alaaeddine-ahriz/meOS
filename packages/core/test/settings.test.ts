import { afterEach, describe, expect, it } from "vitest";
import {
  defaultConfig,
  overlayStoredLlmConfig,
  type LlmConfig,
  type MeosConfig,
} from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

function freshConfig(): MeosConfig {
  return structuredClone(defaultConfig);
}

describe("app settings", () => {
  afterEach(() => {
    delete process.env.MEOS_LLM_PROVIDER;
  });

  it("round-trips JSON values through the settings table", () => {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);

    expect(store.getSetting("llm")).toBeUndefined();
    store.setSetting("llm", { provider: "google", nested: { key: "k" } });
    expect(store.getSetting("llm")).toEqual({ provider: "google", nested: { key: "k" } });

    store.setSetting("llm", { provider: "openai" });
    expect(store.getSetting("llm")).toEqual({ provider: "openai" });
    db.close();
  });

  it("overlays stored LLM settings onto defaults", () => {
    const config = freshConfig();
    const stored: Partial<LlmConfig> = {
      provider: "google",
      google: { model: "gemini-2.5-flash", apiKey: "stored-key" },
    };

    overlayStoredLlmConfig(config, stored);

    expect(config.llm.provider).toBe("google");
    expect(config.llm.google).toEqual({ model: "gemini-2.5-flash", apiKey: "stored-key" });
    // Untouched providers keep their defaults.
    expect(config.llm.anthropic.model).toBe(defaultConfig.llm.anthropic.model);
  });

  it("lets MEOS_LLM_PROVIDER win over stored settings", () => {
    const config = freshConfig();
    process.env.MEOS_LLM_PROVIDER = "stub";

    overlayStoredLlmConfig(config, { provider: "google" });

    expect(config.llm.provider).toBe("stub");
  });
});
