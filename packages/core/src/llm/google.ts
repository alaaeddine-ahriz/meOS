import { z } from "zod";
import type { ChatMessage, CompletionRequest, LlmClient, StructuredRequest } from "./types.js";

export interface GoogleClientOptions {
  model: string;
  /** Falls back to GEMINI_API_KEY / GOOGLE_API_KEY in the environment. */
  apiKey?: string;
}

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MAX_TOKENS = 16000;

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

/**
 * Google Gemini provider, via the generateContent REST API over plain fetch.
 * Structured outputs use responseJsonSchema and are validated locally with zod.
 */
export class GoogleClient implements LlmClient {
  constructor(private readonly options: GoogleClientOptions) {}

  private apiKey(): string {
    const key =
      this.options.apiKey || process.env["GEMINI_API_KEY"] || process.env["GOOGLE_API_KEY"];
    if (!key) throw new Error("Google API key missing — set it in Settings or GEMINI_API_KEY");
    return key;
  }

  private buildBody(request: CompletionRequest, generationConfig: object = {}): object {
    const mapParts = (message: ChatMessage) =>
      typeof message.content === "string"
        ? [{ text: message.content }]
        : message.content.map((part) =>
            part.type === "text"
              ? { text: part.text }
              : { inlineData: { mimeType: part.mediaType, data: part.data } },
          );
    return {
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      contents: request.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: mapParts(m),
      })),
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...generationConfig,
      },
    };
  }

  private async call(method: string, body: object): Promise<Response> {
    const response = await fetch(`${BASE_URL}/models/${this.options.model}:${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey() },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Gemini request failed (${response.status}): ${await response.text()}`);
    }
    return response;
  }

  private static text(data: GeminiResponse): string {
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");
  }

  async complete(request: CompletionRequest): Promise<string> {
    const response = await this.call("generateContent", this.buildBody(request));
    return GoogleClient.text((await response.json()) as GeminiResponse);
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<T> {
    const response = await this.call(
      "generateContent",
      this.buildBody(request, {
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(request.schema),
      }),
    );
    const text = GoogleClient.text((await response.json()) as GeminiResponse);
    if (!text) {
      throw new Error(`Structured completion "${request.schemaName}" returned no output`);
    }
    return request.schema.parse(JSON.parse(text));
  }

  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const response = await this.call("streamGenerateContent?alt=sse", this.buildBody(request));
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
        const delta = GoogleClient.text(JSON.parse(payload.slice(6)) as GeminiResponse);
        if (delta) yield delta;
      }
    }
  }
}
