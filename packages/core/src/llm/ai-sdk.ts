import {
  generateObject,
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import type {
  AgentRequest,
  AgentResult,
  ChatMessage,
  CompletionRequest,
  LlmClient,
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
    const { text } = await generateText({
      model: this.model,
      messages: this.buildMessages(request),
      maxOutputTokens: request.maxTokens ?? this.maxTokens,
    });
    return text;
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<T> {
    const { object } = await generateObject({
      model: this.extractionModel,
      schema: request.schema,
      schemaName: request.schemaName,
      messages: this.buildMessages(request),
      maxOutputTokens: request.maxTokens ?? this.maxTokens,
    });
    return object;
  }

  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const { textStream } = streamText({
      model: this.model,
      messages: this.buildMessages(request),
      maxOutputTokens: request.maxTokens ?? this.maxTokens,
    });
    yield* textStream;
  }

  async runAgent(request: AgentRequest): Promise<AgentResult> {
    const { text, steps } = await generateText({
      model: this.model,
      system: request.system,
      prompt: request.prompt,
      tools: request.tools,
      maxOutputTokens: this.maxTokens,
      stopWhen: stepCountIs(request.maxSteps ?? DEFAULT_MAX_STEPS),
    });
    return { text, steps: steps.length };
  }
}
