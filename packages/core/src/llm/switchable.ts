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

/**
 * Delegating client whose inner provider can be swapped at runtime — the
 * Settings UI changes provider/model/key without restarting the server, while
 * every consumer (pipeline, wiki writer, chat) keeps its reference.
 */
export class SwitchableLlmClient implements LlmClient {
  constructor(private inner: LlmClient) {}

  swap(next: LlmClient): void {
    this.inner = next;
  }

  /**
   * The current delegate. Exposed for INTROSPECTION only — to reason about which
   * backend a switchable client is routed to (e.g. "is this group on a local
   * coding agent or the cloud API?") in diagnostics and tests. Callers must go
   * through the LlmClient methods for actual work, never this, so a later `swap`
   * is always honoured.
   */
  unwrap(): LlmClient {
    return this.inner;
  }

  complete(request: CompletionRequest): Promise<string> {
    return this.inner.complete(request);
  }

  completeStructured<T>(request: StructuredRequest<T>): Promise<T> {
    return this.inner.completeStructured(request);
  }

  stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    return this.inner.stream(request);
  }

  runAgent(request: AgentRequest): Promise<AgentResult> {
    return this.inner.runAgent(request);
  }

  streamAgent(request: AgentStreamRequest): AsyncIterable<AgentActivityChunk> {
    return this.inner.streamAgent(request);
  }
}
