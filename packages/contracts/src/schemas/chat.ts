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
   * Route this turn to a local coding agent instead of the knowledge-base chat.
   * The agent's reasoning, tool calls, and answer stream back over the same SSE
   * frame vocabulary, so the chat UI renders it natively.
   */
  agent: z.boolean().optional(),
  /**
   * Which coding agent to run (`claude` | `codex` | `cursor` | `gemini` |
   * `copilot`). Only meaningful when `agent` is set; absent falls back to the
   * server default (Claude Code). Validated against the installed agents server-side.
   */
  agentId: z.string().optional(),
  /**
   * The model the coding agent should run with this turn (passed to the CLI as
   * `--model`). Only meaningful when `agent` is set; absent falls back to the
   * chosen agent's default model.
   */
  model: z.string().optional(),
});

/** GET /api/coding-agents — every supported coding agent + whether it's installed here. */
export const CodingAgentSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  models: z.array(z.object({ value: z.string(), label: z.string() })),
  defaultModel: z.string(),
  /** False for agents that can't stream a live trace headlessly (answer only). */
  streaming: z.boolean(),
  /** Whether the CLI is installed AND verified on this machine. */
  installed: z.boolean(),
  /** How to install it — shown for not-installed agents. */
  installHint: z.string(),
});
export const CodingAgentsResponse = z.object({ agents: z.array(CodingAgentSummarySchema) });

/**
 * Mid-run questions. When an agent's request is ambiguous it can pause and ask
 * the user to choose, instead of guessing or stopping. The shape mirrors Claude
 * Code's built-in `AskUserQuestion` so any MCP-speaking agent can call our
 * `ask_user` tool with the exact schema it already knows.
 */
export const AskOptionSchema = z.object({
  /** The choice shown to the user. */
  label: z.string(),
  /** A short gloss on what picking this option means. */
  description: z.string().optional(),
});
export const AskQuestionSchema = z.object({
  /** A ≤12-char chip label categorising the question (e.g. "Scope", "Format"). */
  header: z.string(),
  /** The full question. */
  question: z.string(),
  /** 2–4 mutually-exclusive choices (unless `multiSelect`). */
  options: z.array(AskOptionSchema).min(1).max(6),
  /** Allow choosing more than one option. */
  multiSelect: z.boolean().optional(),
});
/** One question's resolved answer: the option label(s) the user chose (or typed). */
export const AskAnswerItemSchema = z.object({
  question: z.string(),
  answers: z.array(z.string()),
});

/** POST /api/agent/ask — the MCP `ask_user` tool's long-poll request. */
export const AskUserBody = z.object({
  /** The run this question belongs to (threaded to the agent's MCP child as `MEOS_AGENT_OP`). */
  op: z.string().min(1),
  questions: z.array(AskQuestionSchema).min(1).max(4),
});
/** POST /api/agent/ask response — resolved once the user answers (or the wait ends). */
export const AskUserResult = z.object({
  status: z.enum(["answered", "timeout", "cancelled", "unavailable"]),
  answers: z.array(AskAnswerItemSchema),
});

/** POST /api/agent/ask/answer — the web client delivering the user's choice. */
export const AskAnswerBody = z.object({
  op: z.string().min(1),
  /** The question id from the `ask-user` SSE frame. */
  id: z.string().min(1),
  answers: z.array(AskAnswerItemSchema),
});
export const AskAnswerResponse = z.object({ ok: z.boolean() });

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
  /**
   * The agent paused to ask the user a question (agent mode). The client renders
   * the choices and POSTs the answer to /api/agent/ask/answer with this `op`+`id`,
   * which unblocks the agent. Live-only — the resolved answer is woven into the
   * persisted turn as the agent's next tool result, so it isn't persisted itself.
   */
  z.object({
    type: z.literal("ask-user"),
    op: z.string(),
    id: z.string(),
    questions: z.array(AskQuestionSchema),
  }),
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
export type CodingAgentSummary = z.infer<typeof CodingAgentSummarySchema>;
export type AskQuestion = z.infer<typeof AskQuestionSchema>;
export type AskAnswerItem = z.infer<typeof AskAnswerItemSchema>;
export type AskUserResultT = z.infer<typeof AskUserResult>;
