import type {
  AgentRequest,
  AgentResult,
  CompletionRequest,
  LlmClient,
  StreamChunk,
  StructuredRequest,
} from "./types.js";

export interface StubHandlers {
  onComplete?: (request: CompletionRequest) => string;
  onStructured?: (request: StructuredRequest<unknown>) => unknown;
  /** Drives an agent run; typically writes deterministic files to request.sandbox. */
  onAgent?: (request: AgentRequest) => Promise<string> | string;
}

/**
 * Deterministic LlmClient for tests and offline development.
 * Responses come from the provided handlers; structured calls are validated
 * against the request schema so tests fail loudly on shape mismatches.
 */
export class StubLlmClient implements LlmClient {
  readonly requests: Array<
    | { kind: "complete" | "structured" | "stream"; request: CompletionRequest }
    | { kind: "agent"; request: AgentRequest }
  > = [];

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

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    this.requests.push({ kind: "stream", request });
    const text = this.handlers.onComplete?.(request) ?? "stub response";
    for (const word of text.split(/(?<=\s)/)) {
      yield { type: "text", text: word };
    }
  }

  async runAgent(request: AgentRequest): Promise<AgentResult> {
    this.requests.push({ kind: "agent", request });
    const text = (await this.handlers.onAgent?.(request)) ?? "stub agent";
    return { text, steps: 1 };
  }
}
