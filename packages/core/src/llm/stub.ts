import type {
  AgentActivityChunk,
  AgentRequest,
  AgentResult,
  AgentStreamRequest,
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
  /**
   * Scripts a {@link streamAgent} run as a list of chunks. A `tool-call` chunk
   * is executed against the request's real tools (so the run's side effects —
   * source collection, store reads — actually happen) and its `tool-result` is
   * emitted automatically; emit other chunk types verbatim. Defaults to a single
   * text chunk.
   */
  onAgentStream?: (request: AgentStreamRequest) => AgentActivityChunk[];
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
    | { kind: "agentStream"; request: AgentStreamRequest }
  > = [];

  constructor(private readonly handlers: StubHandlers = {}) {}

  private completionText(request: CompletionRequest): string {
    return this.handlers.onComplete?.(request) ?? "stub response";
  }

  async complete(request: CompletionRequest): Promise<string> {
    this.requests.push({ kind: "complete", request });
    return this.completionText(request);
  }

  async completeStructured<T>(request: StructuredRequest<T>): Promise<T> {
    this.requests.push({ kind: "structured", request });
    const raw = this.handlers.onStructured?.(request);
    if (raw === undefined) {
      throw new Error(
        `StubLlmClient has no handler for structured request "${request.schemaName}"`,
      );
    }
    return request.schema.parse(raw);
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    this.requests.push({ kind: "stream", request });
    const text = this.completionText(request);
    for (const word of text.split(/(?<=\s)/)) {
      yield { type: "text", text: word };
    }
  }

  async runAgent(request: AgentRequest): Promise<AgentResult> {
    this.requests.push({ kind: "agent", request });
    const text = (await this.handlers.onAgent?.(request)) ?? "stub agent";
    return { text, steps: 1 };
  }

  async *streamAgent(request: AgentStreamRequest): AsyncIterable<AgentActivityChunk> {
    this.requests.push({ kind: "agentStream", request });
    const script = this.handlers.onAgentStream?.(request) ?? [{ type: "text", text: "stub agent" }];
    for (const chunk of script) {
      yield chunk;
      // Run a scripted tool call against the real tool so its side effects fire,
      // then emit the result the model would have seen.
      if (chunk.type === "tool-call") {
        const tool = request.tools[chunk.toolName];
        const output = await tool?.execute?.(chunk.input, {
          toolCallId: chunk.toolCallId ?? "stub",
          messages: [],
        });
        yield {
          type: "tool-result",
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          output,
        };
      }
    }
  }
}
