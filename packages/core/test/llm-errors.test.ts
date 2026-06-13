import { APICallError, LoadAPIKeyError, NoSuchModelError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { LlmError, normalizeLlmError } from "../src/llm/errors.js";

function apiError(opts: { statusCode?: number; message?: string; responseBody?: string }): APICallError {
  return new APICallError({
    message: opts.message ?? "request failed",
    url: "https://api.example.com/v1",
    requestBodyValues: {},
    statusCode: opts.statusCode,
    responseBody: opts.responseBody,
    isRetryable: false,
  });
}

describe("normalizeLlmError", () => {
  it("maps a missing key to an auth error pointing at Settings", () => {
    const error = normalizeLlmError(
      new LoadAPIKeyError({ message: "key missing" }),
      "anthropic",
    );
    expect(error.kind).toBe("auth");
    expect(error.message).toMatch(/Anthropic/);
    expect(error.message).toMatch(/Settings/);
  });

  it("treats 401 as a rejected key", () => {
    const error = normalizeLlmError(apiError({ statusCode: 401 }), "openai");
    expect(error.kind).toBe("auth");
    expect(error.statusCode).toBe(401);
  });

  it("classifies Anthropic's low-credit 400 as a credits error", () => {
    const error = normalizeLlmError(
      apiError({
        statusCode: 400,
        responseBody: '{"error":{"message":"Your credit balance is too low to access the API."}}',
      }),
      "anthropic",
    );
    expect(error.kind).toBe("credits");
    expect(error.message).toMatch(/out of credits|quota/i);
  });

  it("classifies OpenAI insufficient_quota (429) as credits, not rate limiting", () => {
    const error = normalizeLlmError(
      apiError({ statusCode: 429, responseBody: '{"error":{"code":"insufficient_quota"}}' }),
      "openai",
    );
    expect(error.kind).toBe("credits");
  });

  it("treats a plain 429 as a transient rate limit", () => {
    const error = normalizeLlmError(apiError({ statusCode: 429, message: "rate limit" }), "google");
    expect(error.kind).toBe("rate_limit");
  });

  it("maps 5xx to a server error", () => {
    const error = normalizeLlmError(apiError({ statusCode: 503 }), "anthropic");
    expect(error.kind).toBe("server");
  });

  it("unwraps RetryError to classify the underlying failure", () => {
    const inner = apiError({ statusCode: 401 });
    const retry = new RetryError({ message: "failed after retries", reason: "errors", errors: [inner] });
    const error = normalizeLlmError(retry, "openai");
    expect(error.kind).toBe("auth");
  });

  it("maps an unknown model to a model error", () => {
    const error = normalizeLlmError(
      new NoSuchModelError({ modelId: "gpt-nope", modelType: "languageModel" }),
      "openai",
    );
    expect(error.kind).toBe("model");
    expect(error.message).toMatch(/gpt-nope/);
  });

  it("recognises a local connection failure for Ollama", () => {
    const error = normalizeLlmError(new TypeError("fetch failed"), "ollama");
    expect(error.kind).toBe("connection");
    expect(error.message).toMatch(/Ollama/);
  });

  it("passes an already-normalized LlmError through unchanged", () => {
    const original = new LlmError("custom", "credits", "openai");
    expect(normalizeLlmError(original, "anthropic")).toBe(original);
  });

  it("degrades an unrecognized value to an unknown error without leaking internals", () => {
    const error = normalizeLlmError("weird string failure", "google");
    expect(error.kind).toBe("unknown");
    expect(error).toBeInstanceOf(LlmError);
  });
});
