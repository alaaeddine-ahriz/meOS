import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { CompletionRequest, LlmClient, StructuredRequest } from "./types.js";

export interface AnthropicClientOptions {
  model: string;
  extractionModel?: string;
}

const DEFAULT_MAX_TOKENS = 16000;

export class AnthropicClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly extractionModel: string;

  constructor(options: AnthropicClientOptions) {
    this.client = new Anthropic();
    this.model = options.model;
    this.extractionModel = options.extractionModel ?? options.model;
  }

  private buildSystem(request: CompletionRequest) {
    if (!request.system) return undefined;
    return [
      {
        type: "text" as const,
        text: request.system,
        ...(request.cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}),
      },
    ];
  }

  async complete(request: CompletionRequest): Promise<string> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: this.buildSystem(request),
      messages: request.messages,
    });
    const message = await stream.finalMessage();
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<T> {
    const response = await this.client.messages.parse({
      model: this.extractionModel,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: this.buildSystem(request),
      messages: request.messages,
      output_config: { format: zodOutputFormat(request.schema) },
    });
    if (response.parsed_output == null) {
      throw new Error(
        `Structured completion "${request.schemaName}" returned no parseable output (stop_reason: ${response.stop_reason})`,
      );
    }
    return response.parsed_output;
  }

  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: this.buildSystem(request),
      messages: request.messages,
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
  }
}
