import type { Embedder } from "../embedding/embedder.js";
import type { KnowledgeStore, SourceRef } from "../knowledge/store.js";
import type { ChatMessage, LlmClient } from "../llm/types.js";
import type { QueryIntent } from "./query-planner.js";
import { buildContextPack } from "./retrieval.js";

/** Per-intent steer appended to the system prompt, from the query planner. */
const INTENT_GUIDANCE: Partial<Record<QueryIntent, string>> = {
  find_source:
    "The user wants to find where something is recorded. Lead with the source documents, quote the relevant lines, and name the files.",
  trace_timeline:
    "The user wants a timeline. The facts are ordered chronologically and prefixed with dates — narrate the sequence over time.",
  find_contradictions:
    "The user is asking about conflicts. Surface the open contradictions plainly, present both sides, and suggest which is likelier (recency, source authority) without deciding for them.",
  compare:
    "The user wants a comparison. Structure the answer around the dimensions being compared and be explicit about trade-offs.",
  summarize_entity:
    "The user wants an overview of an entity. Lead with its wiki summary, then the most established (semantic, high-confidence) facts.",
};

export type ChatResponseEvent =
  | { type: "sources"; sources: SourceRef[] }
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string };

const SYSTEM_PROMPT = `You are MeOS, the user's personal second brain. You answer questions using ONLY the user's own accumulated knowledge base, provided as context with each question.

Rules:
- Synthesise across sources rather than quoting isolated fragments. Mention which sources or entities an answer draws on, in prose.
- When you mention an entity that appears in the context (a "### Entity:" heading), wrap its name in double brackets — e.g. [[Orion]] — so it links to that entity's wiki page. Never bracket names that are not in the context.
- The context annotates facts with confidence scores. State well-supported facts (>= 0.7) plainly; explicitly hedge weakly-supported ones ("a single note from March suggests...").
- Surface relevant connections the user may not have asked about directly ("this relates to...").
- If the knowledge base does not contain enough information to answer confidently, say so plainly. Never fill gaps with general world knowledge or invention — you are an interface to the user's knowledge, not a general assistant.
- Be concise and specific. This is a thinking tool; answer the question first, elaborate only where it helps.`;

const HISTORY_LIMIT = 20;

export class ChatService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly llm: LlmClient,
    private readonly embedder: Embedder,
  ) {}

  /**
   * Persist the user message, retrieve context, announce which sources the
   * answer draws on, then stream the assistant reply (persisted once the
   * stream completes).
   */
  async *respond(conversationId: number, userMessage: string): AsyncIterable<ChatResponseEvent> {
    const history = this.store
      .listMessages(conversationId)
      .slice(-HISTORY_LIMIT)
      .map((m): ChatMessage => ({ role: m.role, content: m.content }));

    this.store.addMessage(conversationId, "user", userMessage);
    if (history.length === 0) {
      this.store.setConversationTitle(conversationId, userMessage.slice(0, 80));
    }

    const context = await buildContextPack(this.store, this.embedder, userMessage);

    const messages: ChatMessage[] = [
      ...history,
      {
        role: "user",
        content: `<knowledge_context>\n${context.text}\n</knowledge_context>\n\n${userMessage}`,
      },
    ];

    const intentHint = INTENT_GUIDANCE[context.intent];
    const system = intentHint ? `${SYSTEM_PROMPT}\n\n${intentHint}` : SYSTEM_PROMPT;

    if (context.sources.length > 0) {
      yield { type: "sources", sources: context.sources };
    }

    let reply = "";
    for await (const chunk of this.llm.stream({
      system,
      cacheSystem: true,
      messages,
    })) {
      if (chunk.type === "reasoning") {
        yield { type: "reasoning", text: chunk.text };
        continue;
      }
      reply += chunk.text;
      yield { type: "delta", text: chunk.text };
    }
    const messageId = this.store.addMessage(conversationId, "assistant", reply);
    if (context.sources.length > 0) {
      this.store.linkMessageSources(messageId, context.sources.map((source) => source.id));
    }
  }
}
