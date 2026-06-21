import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { LlmConfig, LlmProvider, MeosConfig } from "../config.js";
import { AiSdkClient, type AgentProviderOptions } from "./ai-sdk.js";
import { StubLlmClient } from "./stub.js";
import type { LlmClient } from "./types.js";

/** Curated model choices per cloud provider, shown in Settings. */
export const PROVIDER_MODELS: Record<"anthropic" | "openai" | "google" | "openrouter", string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  openai: ["gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-4.1"],
  google: [
    "gemini-3.1-flash-lite",
    "gemini-3-pro-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
  // OpenRouter slugs are `vendor/model`. A small starter set; the live catalogue
  // (hundreds of models) is fetched in Settings when a key is present.
  openrouter: [
    "anthropic/claude-opus-4-8",
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5.1",
    "google/gemini-2.5-pro",
    "deepseek/deepseek-r1",
  ],
};

/** OpenRouter speaks the OpenAI Chat Completions API at this base. */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Build the OpenRouter provider. Its key isn't OpenAI's, so we resolve it
 * explicitly (config first, then `OPENROUTER_API_KEY`) rather than letting the
 * OpenAI SDK fall back to `OPENAI_API_KEY`. Models are reached over /chat/completions.
 */
function createOpenRouter(apiKey: string | undefined) {
  return createOpenAI({
    baseURL: OPENROUTER_BASE_URL,
    apiKey: apiKey ?? process.env.OPENROUTER_API_KEY,
    name: "openrouter",
  });
}

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
  // Namespaced slugs (`vendor/model`) — match the reasoning families OpenRouter
  // routes, plus its explicit `:thinking` variants.
  openrouter:
    /(claude.*(opus|sonnet|haiku)|gpt-5|chatgpt-5|\bo\d|gemini-(2\.5|3)|deepseek-r|grok-[34]|:thinking|:reasoning)/i,
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
    // OpenRouter forwards OpenAI-style `reasoning_effort` to the backing model.
    case "openrouter":
      return { openai: { reasoningEffort: "medium" } };
    case "google":
      return {
        google: { thinkingConfig: { includeThoughts: true, thinkingBudget: THINKING_BUDGET } },
      };
    default:
      return undefined;
  }
}

/**
 * Resolve a `LanguageModel` for any provider from the stored keys/endpoints,
 * independent of the active provider — so the wiki maintainer can run on a
 * different (reasoning-capable) provider than chat does. The `.chat()` calls
 * pin the OpenAI-compatible providers to /chat/completions: OpenRouter and most
 * local servers (LM Studio, llama.cpp, Ollama's /v1) don't implement the
 * Responses API the default route would use.
 */
function resolveModel(
  llm: LlmConfig,
  provider: LlmProvider,
  modelId: string,
): LanguageModel | null {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: llm.anthropic.apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey: llm.openai.apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: llm.google.apiKey })(modelId);
    case "openrouter":
      return createOpenRouter(llm.openrouter.apiKey).chat(modelId);
    case "local":
      // The key is unused by local servers but the SDK requires a non-empty one.
      return createOpenAI({
        baseURL: normalizeLocalBaseUrl(llm.local.baseUrl),
        apiKey: "local",
        name: "local",
      }).chat(modelId);
    case "stub":
      return null;
  }
}

/** The active provider's main chat model id. */
function mainModelId(llm: LlmConfig, provider: Exclude<LlmProvider, "stub">): string {
  switch (provider) {
    case "anthropic":
      return llm.anthropic.model;
    case "openai":
      return llm.openai.model;
    case "google":
      return llm.google.model;
    case "openrouter":
      return llm.openrouter.model;
    case "local":
      return llm.local.model;
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
  const agentModel = maintainerModelId
    ? resolveModel(llm, maintainerProvider, maintainerModelId)
    : null;
  const agentOptions = maintainerModelId
    ? reasoningOptions(maintainerProvider, maintainerModelId)
    : undefined;

  // resolveModel returns non-null for every provider except "stub", handled above.
  const mainModel = resolveModel(llm, llm.provider, mainModelId(llm, llm.provider))!;
  // Only Anthropic runs extraction on a dedicated model; others reuse the main one.
  const extractionModel =
    llm.provider === "anthropic"
      ? createAnthropic({ apiKey: llm.anthropic.apiKey })(llm.anthropic.extractionModel)
      : undefined;

  return new AiSdkClient(
    mainModel,
    extractionModel,
    undefined,
    llm.provider,
    agentModel ?? mainModel,
    agentOptions,
  );
}

/**
 * The model id that performs knowledge extraction for the active provider —
 * threaded into the extraction cache's version tuple (#15) so a model change
 * invalidates cached partials. Anthropic has a dedicated `extractionModel`; the
 * others extract with their main model. "stub" has no real model.
 */
export function extractionModelId(config: MeosConfig): string {
  const { llm } = config;
  switch (llm.provider) {
    case "anthropic":
      return llm.anthropic.extractionModel;
    case "openai":
      return llm.openai.model;
    case "google":
      return llm.google.model;
    case "openrouter":
      return llm.openrouter.model;
    case "local":
      return llm.local.model || "local";
    case "stub":
      return "stub";
  }
}

export { AiSdkClient } from "./ai-sdk.js";
export { CodingAgentLlmClient } from "./coding-agent-client.js";
export type { CodingAgentLlmClientOptions } from "./coding-agent-client.js";
export {
  DEFAULT_ROUTING_AGENT_ID,
  defaultIntelligenceRouting,
  resolveGroupClient,
  TASK_GROUPS,
  withRoutingDefaults,
} from "./intelligence-routing.js";
export type { IntelligenceRouting, TaskGroup } from "./intelligence-routing.js";
export { listProviderModels } from "./discover.js";
export type { CloudProvider, ModelListing } from "./discover.js";
export {
  LlmError,
  normalizeLlmError,
  providerLabel,
  isProviderFatal,
  llmErrorKindOf,
  PROVIDER_FATAL_KINDS,
} from "./errors.js";
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
