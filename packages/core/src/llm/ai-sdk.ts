import {
  generateObject,
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { normalizeLlmError } from "./errors.js";
import type {
  AgentRequest,
  AgentResult,
  ChatMessage,
  CompletionRequest,
  LlmClient,
  StreamChunk,
  StructuredRequest,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 16000;
const DEFAULT_MAX_STEPS = 12;

/** Mark a system message as a cacheable prefix; non-Anthropic providers ignore it. */
const CACHE_CONTROL = { anthropic: { cacheControl: { type: "ephemeral" as const } } };

/**
 * Single LLM client for every cloud/local provider, built on the Vercel AI
 * SDK. Provider differences live entirely in the `LanguageModel` instance
 * handed to the constructor (see `createLlmClient`); this class only maps our
 * message shape onto the SDK and exposes the four capabilities the rest of the
 * system depends on.
 */
export class AiSdkClient implements LlmClient {
  constructor(
    private readonly model: LanguageModel,
    private readonly extractionModel: LanguageModel = model,
    private readonly maxTokens = DEFAULT_MAX_TOKENS,
    /** Config provider id ("anthropic" | "openai" | …) — used to phrase errors. */
    private readonly provider?: string,
  ) {}

  /**
   * Build the SDK message list, emitting the system prompt as a leading system
   * message so prompt caching can be attached via providerOptions (the v6
   * equivalent of Anthropic's cache_control on the system block).
   */
  private buildMessages(request: CompletionRequest): ModelMessage[] {
    const messages: ModelMessage[] = [];
    if (request.system) {
      messages.push({
        role: "system",
        content: request.system,
        ...(request.cacheSystem ? { providerOptions: CACHE_CONTROL } : {}),
      });
    }
    for (const message of request.messages) {
      messages.push(AiSdkClient.mapMessage(message));
    }
    return messages;
  }

  private static mapMessage(message: ChatMessage): ModelMessage {
    if (typeof message.content === "string") {
      return { role: message.role, content: message.content };
    }
    const content = message.content.map((part) =>
      part.type === "text"
        ? { type: "text" as const, text: part.text }
        : { type: "image" as const, image: part.data, mediaType: part.mediaType },
    );
    // The SDK types user/assistant content parts differently; both accept this
    // text/image union, so a single cast keeps the mapper provider-agnostic.
    return { role: message.role, content } as ModelMessage;
  }

  async complete(request: CompletionRequest): Promise<string> {
    try {
      const { text } = await generateText({
        model: this.model,
        messages: this.buildMessages(request),
        maxOutputTokens: request.maxTokens ?? this.maxTokens,
      });
      return text;
    } catch (error) {
      throw normalizeLlmError(error, this.provider);
    }
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<T> {
    try {
      const { object } = await generateObject({
        model: this.extractionModel,
        schema: request.schema,
        schemaName: request.schemaName,
        messages: this.buildMessages(request),
        maxOutputTokens: request.maxTokens ?? this.maxTokens,
      });
      return object;
    } catch (error) {
      throw normalizeLlmError(error, this.provider);
    }
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    // streamText defers the network call to the first iteration, so a failed
    // request (bad key, no credits) throws while we're draining fullStream —
    // normalize there as well as at construction.
    try {
      const { fullStream } = streamText({
        model: this.model,
        messages: this.buildMessages(request),
        maxOutputTokens: request.maxTokens ?? this.maxTokens,
      });
      for await (const part of fullStream) {
        if (part.type === "text-delta") yield { type: "text", text: part.text };
        else if (part.type === "reasoning-delta") yield { type: "reasoning", text: part.text };
        else if (part.type === "error") throw part.error;
      }
    } catch (error) {
      throw normalizeLlmError(error, this.provider);
    }
  }

  async runAgent(request: AgentRequest): Promise<AgentResult> {
    try {
      const { text, steps } = await generateText({
        model: this.model,
        system: request.system,
        prompt: request.prompt,
        tools: request.tools,
        maxOutputTokens: this.maxTokens,
        stopWhen: stepCountIs(request.maxSteps ?? DEFAULT_MAX_STEPS),
      });
      return { text, steps: steps.length };
    } catch (error) {
      throw normalizeLlmError(error, this.provider);
    }
  }
}
