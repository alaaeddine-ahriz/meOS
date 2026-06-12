import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ChatMessage, CompletionRequest, LlmClient, StructuredRequest } from "./types.js";

export interface AnthropicClientOptions {
  model: string;
  extractionModel?: string;
  /** Falls back to ANTHROPIC_API_KEY in the environment. */
  apiKey?: string;
}

const DEFAULT_MAX_TOKENS = 16000;

export class AnthropicClient implements LlmClient {
  private lazyClient?: Anthropic;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly extractionModel: string;

  constructor(options: AnthropicClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.extractionModel = options.extractionModel ?? options.model;
  }

  /**
   * Constructed on first use, not in the constructor — the SDK throws when no
   * key is available, and the server must boot keyless so the user can paste
   * one in Settings.
   */
  private get client(): Anthropic {
    if (!this.lazyClient) {
      const apiKey = this.apiKey || process.env["ANTHROPIC_API_KEY"];
      if (!apiKey) {
        throw new Error("Anthropic API key missing — set it in Settings or ANTHROPIC_API_KEY");
      }
      this.lazyClient = new Anthropic({ apiKey });
    }
    return this.lazyClient;
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

  private buildMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
    return messages.map((message) => ({
      role: message.role,
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((part): Anthropic.ContentBlockParam =>
              part.type === "text"
                ? { type: "text", text: part.text }
                : {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: part.mediaType as "image/png",
                      data: part.data,
                    },
                  },
            ),
    }));
  }

  async complete(request: CompletionRequest): Promise<string> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: this.buildSystem(request),
      messages: this.buildMessages(request.messages),
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
      messages: this.buildMessages(request.messages),
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
      messages: this.buildMessages(request.messages),
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
  }
}
