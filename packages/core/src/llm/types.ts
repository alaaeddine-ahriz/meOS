import type { ToolSet } from "ai";
import type { Sandbox } from "bash-tool";
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

/**
 * A streamed chunk of an agent run, surfaced live so the UI can render the
 * agent the way an AI IDE does: its private reasoning, each tool call (read,
 * grep, write) with its input, the tool's result, and the visible text it
 * emits between steps.
 */
export type AgentActivityChunk =
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId?: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId?: string; toolName: string; output: unknown }
  | { type: "text"; text: string };

/**
 * A tool-using agent run. `tools` and `sandbox` come from a single bash-tool
 * toolkit: the model edits files through `tools`, and those edits land in the
 * same in-memory `sandbox` — which the caller reads back afterwards. The
 * sandbox is carried on the request so test stubs can produce deterministic
 * output by writing to it directly instead of driving a real tool loop.
 */
export interface AgentRequest {
  system?: string;
  prompt: string;
  tools: ToolSet;
  sandbox: Sandbox;
  maxSteps?: number;
  /**
   * Fires for each reasoning/tool/text chunk as the run unfolds, so callers can
   * stream a live transcript. Best-effort: a throwing sink is ignored so it can
   * never abort the agent run.
   */
  onActivity?: (chunk: AgentActivityChunk) => void;
}

export interface AgentResult {
  text: string;
  steps: number;
}

/**
 * A streaming, sandbox-free tool-using run — the agentic chat's seam. Unlike
 * {@link AgentRequest} (the wiki maintainer, which edits files in a bash-tool
 * sandbox), this carries a multi-turn conversation and a {@link ToolSet} whose
 * tools `execute` against the knowledge base directly. The run is consumed as an
 * async iterable so the chat can stream the model's reasoning, each tool call /
 * result, and the answer text the moment they arrive.
 */
export interface AgentStreamRequest {
  system?: string;
  /** Conversation history plus the current user turn. */
  messages: ChatMessage[];
  tools: ToolSet;
  maxSteps?: number;
}

/** A streamed completion chunk: either visible answer text or model reasoning. */
export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string };

export interface LlmClient {
  /** Single text completion. */
  complete(request: CompletionRequest): Promise<string>;
  /** Completion constrained to a zod schema; returns the validated object. */
  completeStructured<T>(request: StructuredRequest<T>): Promise<T>;
  /** Streaming completion; yields answer-text and reasoning chunks. */
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
  /** Multi-step tool-using run over a bash-tool sandbox. */
  runAgent(request: AgentRequest): Promise<AgentResult>;
  /** Streaming, sandbox-free tool-using run — powers the agentic chat. */
  streamAgent(request: AgentStreamRequest): AsyncIterable<AgentActivityChunk>;
}

/** Flatten message content to plain text (images dropped) — for providers without vision. */
export function contentToText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
