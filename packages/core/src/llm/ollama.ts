import { z } from "zod";
import { contentToText, type CompletionRequest, type LlmClient, type StructuredRequest } from "./types.js";

export interface OllamaClientOptions {
  baseUrl: string;
  model: string;
}

/**
 * Local-mode provider: a fully offline second brain via an Ollama-served
 * model. Lower capability than the cloud provider, but no data leaves the
 * machine and no API credentials are needed.
 */
export class OllamaClient implements LlmClient {
  constructor(private readonly options: OllamaClientOptions) {}

  private buildMessages(request: CompletionRequest) {
    return [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      ...request.messages.map((message) => {
        const images =
          typeof message.content === "string"
            ? []
            : message.content.filter((part) => part.type === "image").map((part) => part.data);
        return {
          role: message.role,
          content: contentToText(message.content),
          ...(images.length > 0 ? { images } : {}),
        };
      }),
    ];
  }

  private async chat(body: object): Promise<Response> {
    const response = await fetch(`${this.options.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.options.model, ...body }),
    });
    if (!response.ok) {
      throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);
    }
    return response;
  }

  async complete(request: CompletionRequest): Promise<string> {
    const response = await this.chat({ messages: this.buildMessages(request), stream: false });
    const data = (await response.json()) as { message: { content: string } };
    return data.message.content;
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<T> {
    const response = await this.chat({
      messages: this.buildMessages(request),
      stream: false,
      format: z.toJSONSchema(request.schema),
    });
    const data = (await response.json()) as { message: { content: string } };
    return request.schema.parse(JSON.parse(data.message.content));
  }

  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const response = await this.chat({ messages: this.buildMessages(request), stream: true });
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
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as { message?: { content?: string } };
        if (chunk.message?.content) yield chunk.message.content;
      }
    }
  }
}
