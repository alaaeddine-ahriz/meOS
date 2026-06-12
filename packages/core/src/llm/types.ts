import type { z } from "zod";

/** A piece of multimodal message content. Image data is base64-encoded. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

export interface CompletionRequest {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Mark the system prompt as a stable prefix eligible for provider-side caching. */
  cacheSystem?: boolean;
}

export interface StructuredRequest<T> extends CompletionRequest {
  schema: z.ZodType<T>;
  schemaName: string;
}

export interface LlmClient {
  /** Single text completion. */
  complete(request: CompletionRequest): Promise<string>;
  /** Completion constrained to a zod schema; returns the validated object. */
  completeStructured<T>(request: StructuredRequest<T>): Promise<T>;
  /** Streaming completion; yields text deltas. */
  stream(request: CompletionRequest): AsyncIterable<string>;
}

/** Flatten message content to plain text (images dropped) — for providers without vision. */
export function contentToText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
