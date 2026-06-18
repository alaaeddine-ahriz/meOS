import type { LlmProvider } from "../api.js";

/**
 * Mirror of core's `isReasoningModel` for client-side hints (flagging reasoning
 * models in the maintainer picker). The server stays authoritative — it computes
 * the same flag in the settings view — this just avoids a round-trip per option.
 */
const REASONING_PATTERNS: Partial<Record<LlmProvider, RegExp>> = {
  anthropic: /claude.*(opus|sonnet|haiku)/i,
  openai: /^(o\d|gpt-5|chatgpt-5)/i,
  google: /gemini-(2\.5|3)/i,
  openrouter:
    /(claude.*(opus|sonnet|haiku)|gpt-5|chatgpt-5|\bo\d|gemini-(2\.5|3)|deepseek-r|grok-[34]|:thinking|:reasoning)/i,
};

export function isReasoningModel(provider: LlmProvider, modelId: string | undefined): boolean {
  if (!modelId) return false;
  return REASONING_PATTERNS[provider]?.test(modelId) ?? false;
}
