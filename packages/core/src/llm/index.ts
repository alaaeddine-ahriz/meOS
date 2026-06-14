import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { LlmConfig, LlmProvider, MeosConfig } from "../config.js";
import { AiSdkClient, type AgentProviderOptions } from "./ai-sdk.js";
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

/** Reasoning-capable model families, used to gate the wiki-maintainer model. */
const REASONING_PATTERNS: Partial<Record<LlmProvider, RegExp>> = {
  // Claude 4.x Opus/Sonnet/Haiku support extended thinking.
  anthropic: /claude.*(opus|sonnet|haiku)/i,
  // o-series and GPT-5 are reasoning models; gpt-4.x are not.
  openai: /^(o\d|gpt-5|chatgpt-5)/i,
  // Gemini 2.5 / 3 expose thinking.
  google: /gemini-(2\.5|3)/i,
};

/**
 * Whether a model can emit reasoning we can stream — drives the "choose a
 * reasoning-capable model" prompt and whether we turn thinking on. Local/stub
 * are treated as non-reasoning since we can't know the served model's traits.
 */
export function isReasoningModel(provider: LlmProvider, modelId: string | undefined): boolean {
  if (!modelId) return false;
  return REASONING_PATTERNS[provider]?.test(modelId) ?? false;
}

/** Tokens the maintainer may spend thinking — comfortably under runAgent's output budget. */
const THINKING_BUDGET = 4000;

/** Provider-specific options that switch reasoning on, when the model supports it. */
function reasoningOptions(provider: LlmProvider, modelId: string): AgentProviderOptions {
  if (!isReasoningModel(provider, modelId)) return undefined;
  switch (provider) {
    case "anthropic":
      return { anthropic: { thinking: { type: "enabled", budgetTokens: THINKING_BUDGET } } };
    case "openai":
      return { openai: { reasoningEffort: "medium", reasoningSummary: "auto" } };
    case "google":
      return { google: { thinkingConfig: { includeThoughts: true, thinkingBudget: THINKING_BUDGET } } };
    default:
      return undefined;
  }
}

/**
 * Resolve a `LanguageModel` for any provider from the stored keys/endpoints,
 * independent of the active provider — so the wiki maintainer can run on a
 * different (reasoning-capable) provider than chat does.
 */
function resolveModel(llm: LlmConfig, provider: LlmProvider, modelId: string): LanguageModel | null {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: llm.anthropic.apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey: llm.openai.apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: llm.google.apiKey })(modelId);
    case "local":
      return createOpenAI({
        baseURL: normalizeLocalBaseUrl(llm.local.baseUrl),
        apiKey: "local",
        name: "local",
      }).chat(modelId);
    case "stub":
      return null;
  }
}

/**
 * Build the right AI SDK provider/model from config and wrap it once in the
 * common client. Provider factories read their API key lazily (env at call
 * time when none is passed), so the server still boots keyless and the user
 * can paste a key in Settings. The wiki-maintainer ("agent") model is resolved
 * separately so it can be a reasoning-capable model on any provider.
 */
export function createLlmClient(config: MeosConfig): LlmClient {
  const { llm } = config;
  if (llm.provider === "stub") return new StubLlmClient();

  // The maintainer model: explicit when configured, else the active main model
  // (with reasoning left off, preserving the prior headless behaviour).
  const maintainerProvider = llm.maintainer?.provider ?? llm.provider;
  const maintainerModelId = llm.maintainer?.model;
  const agentModel = maintainerModelId ? resolveModel(llm, maintainerProvider, maintainerModelId) : null;
  const agentOptions = maintainerModelId ? reasoningOptions(maintainerProvider, maintainerModelId) : undefined;

  switch (llm.provider) {
    case "anthropic": {
      const provider = createAnthropic({ apiKey: llm.anthropic.apiKey });
      return new AiSdkClient(
        provider(llm.anthropic.model),
        provider(llm.anthropic.extractionModel),
        undefined,
        "anthropic",
        agentModel ?? provider(llm.anthropic.model),
        agentOptions,
      );
    }
    case "openai": {
      const provider = createOpenAI({ apiKey: llm.openai.apiKey });
      return new AiSdkClient(
        provider(llm.openai.model),
        undefined,
        undefined,
        "openai",
        agentModel ?? provider(llm.openai.model),
        agentOptions,
      );
    }
    case "google": {
      const provider = createGoogleGenerativeAI({ apiKey: llm.google.apiKey });
      return new AiSdkClient(
        provider(llm.google.model),
        undefined,
        undefined,
        "google",
        agentModel ?? provider(llm.google.model),
        agentOptions,
      );
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
      return new AiSdkClient(
        provider.chat(llm.local.model),
        undefined,
        undefined,
        "local",
        agentModel ?? provider.chat(llm.local.model),
        agentOptions,
      );
    }
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
  AgentActivityChunk,
  AgentRequest,
  AgentResult,
  AgentStreamRequest,
  ChatMessage,
  CompletionRequest,
  ContentPart,
  LlmClient,
  StructuredRequest,
} from "./types.js";
