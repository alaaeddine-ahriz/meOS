import type { CompletionRequest, LlmClient, StructuredRequest } from "./types.js";

export interface StubHandlers {
  onComplete?: (request: CompletionRequest) => string;
  onStructured?: (request: StructuredRequest<unknown>) => unknown;
}

/**
 * Deterministic LlmClient for tests and offline development.
 * Responses come from the provided handlers; structured calls are validated
 * against the request schema so tests fail loudly on shape mismatches.
 */
export class StubLlmClient implements LlmClient {
  readonly requests: Array<{ kind: "complete" | "structured" | "stream"; request: CompletionRequest }> = [];

  constructor(private readonly handlers: StubHandlers = {}) {}

  async complete(request: CompletionRequest): Promise<string> {
    this.requests.push({ kind: "complete", request });
    return this.handlers.onComplete?.(request) ?? "stub response";
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<T> {
    this.requests.push({ kind: "structured", request });
    const raw = this.handlers.onStructured?.(request);
    if (raw === undefined) {
      throw new Error(`StubLlmClient has no handler for structured request "${request.schemaName}"`);
    }
    return request.schema.parse(raw);
  }

  async *stream(request: CompletionRequest): AsyncIterable<string> {
    this.requests.push({ kind: "stream", request });
    const text = this.handlers.onComplete?.(request) ?? "stub response";
    for (const word of text.split(/(?<=\s)/)) {
      yield word;
    }
  }
}
