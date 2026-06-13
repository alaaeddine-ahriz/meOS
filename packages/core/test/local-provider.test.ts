import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { createLlmClient, normalizeLocalBaseUrl } from "../src/llm/index.js";

describe("normalizeLocalBaseUrl", () => {
  it("appends /v1 when the URL lacks a version segment", () => {
    expect(normalizeLocalBaseUrl("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeLocalBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
  });

  it("leaves an existing version segment untouched", () => {
    expect(normalizeLocalBaseUrl("http://127.0.0.1:1234/v1")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeLocalBaseUrl("http://host:8000/v2")).toBe("http://host:8000/v2");
  });

  it("strips trailing slashes before deciding", () => {
    expect(normalizeLocalBaseUrl("http://127.0.0.1:1234/")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeLocalBaseUrl("http://127.0.0.1:1234/v1/")).toBe("http://127.0.0.1:1234/v1");
  });

  it("passes an empty string through (nothing to normalize)", () => {
    expect(normalizeLocalBaseUrl("")).toBe("");
    expect(normalizeLocalBaseUrl("   ")).toBe("");
  });
});

describe("createLlmClient (local)", () => {
  it("builds a client for the local provider exposing all capabilities", () => {
    const config = structuredClone(defaultConfig);
    config.llm.provider = "local";
    config.llm.local = { baseUrl: "http://127.0.0.1:1234", model: "some-model" };
    const client = createLlmClient(config);
    for (const method of ["complete", "completeStructured", "stream", "runAgent"] as const) {
      expect(typeof client[method]).toBe("function");
    }
  });
});
