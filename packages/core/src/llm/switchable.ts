import type { AgentRequest, AgentResult, CompletionRequest, LlmClient, StreamChunk, StructuredRequest } from "./types.js";

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
}
