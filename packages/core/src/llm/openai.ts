import { z } from "zod";
import type { ChatMessage, CompletionRequest, LlmClient, StructuredRequest } from "./types.js";

export interface OpenAiClientOptions {
  model: string;
  /** Falls back to OPENAI_API_KEY in the environment. */
  apiKey?: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_TOKENS = 16000;

/**
 * OpenAI provider, via the Chat Completions API over plain fetch — the same
 * dependency-free approach as the Ollama client. Structured outputs use
 * response_format json_schema and are validated locally with zod.
 */
export class OpenAiClient implements LlmClient {
  constructor(private readonly options: OpenAiClientOptions) {}

  private apiKey(): string {
    const key = this.options.apiKey || process.env["OPENAI_API_KEY"];
    if (!key) throw new Error("OpenAI API key missing — set it in Settings or OPENAI_API_KEY");
    return key;
  }

  private buildMessages(request: CompletionRequest): object[] {
    const mapContent = (message: ChatMessage) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) =>
            part.type === "text"
              ? { type: "text", text: part.text }
              : { type: "image_url", image_url: { url: `data:${part.mediaType};base64,${part.data}` } },
          );
    return [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: mapContent(m) })),
    ];
  }

  private async chat(request: CompletionRequest, extra: object): Promise<Response> {
    const response = await fetch(`${this.options.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey()}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: this.buildMessages(request),
        max_completion_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...extra,
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI request failed (${response.status}): ${await response.text()}`);
    }
    return response;
  }

  async complete(request: CompletionRequest): Promise<string> {
    const response = await this.chat(request, {});
    const data = (await response.json()) as { choices: Array<{ message: { content: string | null } }> };
    return data.choices[0]?.message.content ?? "";
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<T> {
    const response = await this.chat(request, {
      response_format: {
        type: "json_schema",
        json_schema: { name: request.schemaName, schema: z.toJSONSchema(request.schema) },
      },
    });
    const data = (await response.json()) as { choices: Array<{ message: { content: string | null } }> };
    const content = data.choices[0]?.message.content;
    if (!content) {
      throw new Error(`Structured completion "${request.schemaName}" returned no output`);
    }
    return request.schema.parse(JSON.parse(content));
  }

  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const response = await this.chat(request, { stream: true });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const payload = line.trim();
        if (!payload.startsWith("data: ")) continue;
        const json = payload.slice(6);
        if (json === "[DONE]") return;
        const chunk = JSON.parse(json) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    }
  }
}
