import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { MeosConfig } from "../config.js";
import { AiSdkClient } from "./ai-sdk.js";
import { StubLlmClient } from "./stub.js";
import type { LlmClient } from "./types.js";

/** Curated model choices per cloud provider, shown in Settings. */
export const PROVIDER_MODELS: Record<"anthropic" | "openai" | "google", string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  openai: ["gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-4.1"],
  google: [
    "gemini-3.1-flash-lite",
    "gemini-3-pro-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
};

/**
 * Coerce a local server URL onto its OpenAI-compatible `/v1` surface. Users
 * commonly paste what LM Studio shows as the server address (`http://host:1234`)
 * without the `/v1` the OpenAI endpoints actually live under — appending it
 * keeps both inference (`/v1/chat/completions`) and discovery (`/v1/models`)
 * working. A URL that already ends in a version segment is left untouched.
 */
export function normalizeLocalBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Build the right AI SDK provider/model from config and wrap it once in the
 * common client. Provider factories read their API key lazily (env at call
 * time when none is passed), so the server still boots keyless and the user
 * can paste a key in Settings.
 */
export function createLlmClient(config: MeosConfig): LlmClient {
  const { llm } = config;
  switch (llm.provider) {
    case "anthropic": {
      const provider = createAnthropic({ apiKey: llm.anthropic.apiKey });
      return new AiSdkClient(
        provider(llm.anthropic.model),
        provider(llm.anthropic.extractionModel),
        undefined,
        "anthropic",
      );
    }
    case "openai": {
      const provider = createOpenAI({ apiKey: llm.openai.apiKey });
      return new AiSdkClient(provider(llm.openai.model), undefined, undefined, "openai");
    }
    case "google": {
      const provider = createGoogleGenerativeAI({ apiKey: llm.google.apiKey });
      return new AiSdkClient(provider(llm.google.model), undefined, undefined, "google");
    }
    case "local": {
      // Any OpenAI-compatible local server (LM Studio, llama.cpp, Ollama's /v1).
      // The key is unused by local servers but the SDK requires a non-empty one.
      // `.chat()` forces the /chat/completions route these servers implement.
      const provider = createOpenAI({
        baseURL: normalizeLocalBaseUrl(llm.local.baseUrl),
        apiKey: "local",
        name: "local",
      });
      return new AiSdkClient(provider.chat(llm.local.model), undefined, undefined, "local");
    }
    case "stub":
      return new StubLlmClient();
  }
}

export { AiSdkClient } from "./ai-sdk.js";
export { listProviderModels } from "./discover.js";
export type { CloudProvider, ModelListing } from "./discover.js";
export { LlmError, normalizeLlmError, providerLabel } from "./errors.js";
export type { LlmErrorKind } from "./errors.js";
export { StubLlmClient } from "./stub.js";
export { SwitchableLlmClient } from "./switchable.js";
export type { StubHandlers } from "./stub.js";
export { contentToText } from "./types.js";
export type {
  AgentRequest,
  AgentResult,
  ChatMessage,
  CompletionRequest,
  ContentPart,
  LlmClient,
  StructuredRequest,
} from "./types.js";
