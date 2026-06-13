import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider-v2";
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
    case "ollama": {
      const provider = createOllama({ baseURL: `${llm.ollama.baseUrl}/api` });
      return new AiSdkClient(provider(llm.ollama.model), undefined, undefined, "ollama");
    }
    case "stub":
      return new StubLlmClient();
  }
}

export { AiSdkClient } from "./ai-sdk.js";
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
