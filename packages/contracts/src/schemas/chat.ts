import { z } from "zod";
import { GraphLinkSchema, GraphNodeSchema, NumericIdParam, SourceRefSchema } from "./common.js";

/** Coarse cause of an LLM failure; mirrors core's LlmErrorKind. */
export const LlmErrorKindSchema = z.enum([
  "auth",
  "credits",
  "rate_limit",
  "timeout",
  "connection",
  "model",
  "bad_response",
  "bad_request",
  "server",
  "unknown",
]);

/** POST /api/conversations */
export const CreateConversationResponse = z.object({ id: z.number() });

/** GET /api/conversations */
export const ConversationSchema = z.object({
  id: z.number(),
  title: z.string().nullable(),
  created_at: z.string(),
});
export const ListConversationsResponse = z.object({ conversations: z.array(ConversationSchema) });

/** GET /api/conversations/:id/messages */
export const ConversationIdParam = NumericIdParam;
export const MessageSchema = z.object({
  id: z.number(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  created_at: z.string(),
  /** Documents the reply drew on; persisted server-side, absent on pending messages. */
  sources: z.array(SourceRefSchema).optional(),
});
export const MessagesResponse = z.object({ messages: z.array(MessageSchema) });

/** POST /api/conversations/:id/end */
export const EndConversationResponse = z.object({ crystallizing: z.boolean() });

/** POST /api/chat (SSE stream; body validated, response is a stream) */
export const ChatBody = z.object({
  conversationId: z.number().optional(),
  message: z.string().min(1),
  /**
   * Route this turn to the local coding agent (Claude Code) instead of the
   * knowledge-base chat. The agent's reasoning, tool calls, and answer stream
   * back over the same SSE frame vocabulary, so the chat UI renders it natively.
   */
  agent: z.boolean().optional(),
  /**
   * The model the coding agent should run with this turn (passed to the CLI as
   * `--model`). Typically a version-proof alias (`opus` | `sonnet` | `haiku`).
   * Only meaningful when `agent` is set; absent falls back to the stored default.
   */
  model: z.string().optional(),
});

/** Frames emitted on the /api/chat SSE stream. */
export const ChatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), conversationId: z.number() }),
  z.object({
    type: z.literal("sources"),
    sources: z.array(SourceRefSchema),
    /**
     * Wiki pages an answer drew on (agent mode surfaces the [[entities]] its
     * meOS tools consulted). Distinct from `sources` (raw documents): these link
     * to a wiki page, not a file. Live-only — like the traversed `graph`, not
     * persisted on the message.
     */
    pages: z.array(z.object({ name: z.string(), slug: z.string(), type: z.string() })).optional(),
  }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string().optional(),
    toolName: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool-result"),
    toolCallId: z.string().optional(),
    toolName: z.string(),
    output: z.unknown(),
    /** Set by coding-agent tools whose execution failed, so the UI shows an error state. */
    isError: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("graph"),
    nodes: z.array(GraphNodeSchema),
    links: z.array(GraphLinkSchema),
  }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string(), kind: LlmErrorKindSchema.optional() }),
]);

/** GET /api/search?q= */
export const SearchQuery = z.object({ q: z.string().min(1) });
export const SearchResponse = z.object({
  entities: z.array(z.object({ name: z.string(), slug: z.string(), type: z.string() })),
  sources: z.array(SourceRefSchema),
});

export type Conversation = z.infer<typeof ConversationSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type LlmErrorKind = z.infer<typeof LlmErrorKindSchema>;
