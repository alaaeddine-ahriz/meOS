import type { MeosConfig } from "../config.js";
import { AnthropicClient } from "./anthropic.js";
import { GoogleClient } from "./google.js";
import { OllamaClient } from "./ollama.js";
import { OpenAiClient } from "./openai.js";
import { StubLlmClient } from "./stub.js";
import type { LlmClient } from "./types.js";

/** Curated model choices per cloud provider, shown in Settings. */
export const PROVIDER_MODELS: Record<"anthropic" | "openai" | "google", string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  openai: ["gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-4.1"],
  google: ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
};

export function createLlmClient(config: MeosConfig): LlmClient {
  switch (config.llm.provider) {
    case "anthropic":
      return new AnthropicClient(config.llm.anthropic);
    case "openai":
      return new OpenAiClient(config.llm.openai);
    case "google":
      return new GoogleClient(config.llm.google);
    case "ollama":
      return new OllamaClient(config.llm.ollama);
    case "stub":
      return new StubLlmClient();
  }
}

export { AnthropicClient } from "./anthropic.js";
export { GoogleClient } from "./google.js";
export { OllamaClient } from "./ollama.js";
export { OpenAiClient } from "./openai.js";
export { StubLlmClient } from "./stub.js";
export { SwitchableLlmClient } from "./switchable.js";
export type { StubHandlers } from "./stub.js";
export { contentToText } from "./types.js";
export type { ChatMessage, CompletionRequest, ContentPart, LlmClient, StructuredRequest } from "./types.js";
