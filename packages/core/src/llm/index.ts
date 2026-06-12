import type { MeosConfig } from "../config.js";
import { AnthropicClient } from "./anthropic.js";
import { OllamaClient } from "./ollama.js";
import { StubLlmClient } from "./stub.js";
import type { LlmClient } from "./types.js";

export function createLlmClient(config: MeosConfig): LlmClient {
  switch (config.llm.provider) {
    case "anthropic":
      return new AnthropicClient(config.llm.anthropic);
    case "ollama":
      return new OllamaClient(config.llm.ollama);
    case "stub":
      return new StubLlmClient();
  }
}

export { AnthropicClient } from "./anthropic.js";
export { OllamaClient } from "./ollama.js";
export { StubLlmClient } from "./stub.js";
export type { StubHandlers } from "./stub.js";
export type { ChatMessage, CompletionRequest, LlmClient, StructuredRequest } from "./types.js";
