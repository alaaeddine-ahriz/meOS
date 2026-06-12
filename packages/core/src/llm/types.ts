import type { z } from "zod";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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
